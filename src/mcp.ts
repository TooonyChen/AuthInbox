const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_HTTP_MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_MCP_MAIL_LIMIT = 50;

const MCP_TOOLS = [
	{
		name: 'get_latest_mail',
		title: 'Get Latest Mail',
		description: 'Return the newest extracted mail with parsed details and decoded message bodies.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: 'get_multiple_mail',
		title: 'Get Multiple Mail',
		description: `Return the newest extracted mails sorted by createdAt descending. Defaults to 5 and caps at ${MAX_MCP_MAIL_LIMIT}.`,
		inputSchema: {
			type: 'object',
			properties: {
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: MAX_MCP_MAIL_LIMIT,
					default: 5,
					description: `How many latest mails to return. Defaults to 5, maximum ${MAX_MCP_MAIL_LIMIT}.`,
				},
			},
			additionalProperties: false,
		},
	},
] as const;

type SupportedMcpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
type JsonRpcId = string | number | null;

export interface McpMailDetail {
	id: number;
	messageId: string | null;
	fromOrg: string | null;
	fromAddr: string | null;
	toAddr: string | null;
	subject: string | null;
	topic: string | null;
	code: string | null;
	createdAt: string | null;
	textBody: string | null;
	htmlBody: string | null;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedMcpProtocolVersion(value: string): value is SupportedMcpProtocolVersion {
	return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function getEffectiveMcpProtocolVersion(request: Request): SupportedMcpProtocolVersion {
	const headerValue = request.headers.get('MCP-Protocol-Version');
	if (headerValue && isSupportedMcpProtocolVersion(headerValue)) {
		return headerValue;
	}
	return DEFAULT_HTTP_MCP_PROTOCOL_VERSION;
}

function buildMcpResponseHeaders(protocolVersion?: SupportedMcpProtocolVersion): Record<string, string> {
	const headers: Record<string, string> = {
		'Cache-Control': 'no-store',
	};

	if (protocolVersion) {
		headers['MCP-Protocol-Version'] = protocolVersion;
	}

	return headers;
}

function methodNotAllowedResponse(allowed: string): Response {
	return new Response('Method Not Allowed', {
		status: 405,
		headers: {
			Allow: allowed,
			'Cache-Control': 'no-store',
		},
	});
}

function acceptedMcpNotificationResponse(protocolVersion?: SupportedMcpProtocolVersion): Response {
	return new Response(null, {
		status: 202,
		headers: buildMcpResponseHeaders(protocolVersion),
	});
}

function makeJsonRpcSuccessResponse(id: JsonRpcId, result: unknown, protocolVersion: SupportedMcpProtocolVersion): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: '2.0',
			id,
			result,
		}),
		{
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				...buildMcpResponseHeaders(protocolVersion),
			},
		}
	);
}

function makeJsonRpcErrorResponse(
	id: JsonRpcId,
	code: number,
	message: string,
	protocolVersion: SupportedMcpProtocolVersion,
	data?: unknown
): Response {
	const errorBody: {
		jsonrpc: '2.0';
		id: JsonRpcId;
		error: {
			code: number;
			message: string;
			data?: unknown;
		};
	} = {
		jsonrpc: '2.0',
		id,
		error: {
			code,
			message,
		},
	};

	if (data !== undefined) {
		errorBody.error.data = data;
	}

	return new Response(JSON.stringify(errorBody), {
		status: code === -32700 || code === -32600 ? 400 : 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...buildMcpResponseHeaders(protocolVersion),
		},
	});
}

function makeMcpToolResult(payload: Record<string, unknown>, isError = false) {
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify(payload, null, 2),
			},
		],
		structuredContent: payload,
		...(isError ? { isError: true } : {}),
	};
}

function isAllowedMcpOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	if (!origin || origin === 'null') {
		return true;
	}

	return origin === new URL(request.url).origin;
}

function parsePositiveInteger(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return value;
	}

	if (typeof value === 'string' && /^\d+$/.test(value)) {
		const parsedValue = Number.parseInt(value, 10);
		return parsedValue > 0 ? parsedValue : null;
	}

	return null;
}

async function executeMcpTool(
	name: string,
	args: Record<string, unknown> | undefined,
	readLatestMailDetails: (limit: number) => Promise<McpMailDetail[]>
): Promise<Record<string, unknown>> {
	if (name === 'get_latest_mail') {
		const [mail] = await readLatestMailDetails(1);
		return {
			mail: mail ?? null,
		};
	}

	if (name === 'get_multiple_mail') {
		let limit = 5;
		if (args?.limit !== undefined) {
			const parsedLimit = parsePositiveInteger(args.limit);
			if (parsedLimit === null) {
				throw new Error('limit must be a positive integer.');
			}
			limit = Math.min(MAX_MCP_MAIL_LIMIT, parsedLimit);
		}

		const mails = await readLatestMailDetails(limit);
		return {
			limit,
			count: mails.length,
			mails,
		};
	}

	throw new Error(`Tool not found: ${name}`);
}

export function buildMcpBasicAuthConfigSnippet(mcpUrl: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				authInbox: {
					url: mcpUrl,
					headers: {
						Authorization: 'Basic <base64(username:password)>',
					},
				},
			},
		},
		null,
		2
	);
}

export async function handleMcpRequest(
	request: Request,
	readLatestMailDetails: (limit: number) => Promise<McpMailDetail[]>
): Promise<Response> {
	if (!isAllowedMcpOrigin(request)) {
		return new Response(JSON.stringify({ error: 'Forbidden origin for MCP endpoint.' }), {
			status: 403,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}

	if (request.method !== 'POST') {
		return methodNotAllowedResponse('POST');
	}

	const headerProtocolVersion = request.headers.get('MCP-Protocol-Version');
	if (headerProtocolVersion && !isSupportedMcpProtocolVersion(headerProtocolVersion)) {
		return new Response(
			JSON.stringify({
				error: 'Unsupported MCP-Protocol-Version header.',
				supported: [...MCP_PROTOCOL_VERSIONS],
			}),
			{
				status: 400,
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-store',
				},
			}
		);
	}

	const protocolVersion = getEffectiveMcpProtocolVersion(request);

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return makeJsonRpcErrorResponse(null, -32700, 'Parse error', protocolVersion);
	}

	if (Array.isArray(payload) || !isRecord(payload) || payload.jsonrpc !== '2.0') {
		return makeJsonRpcErrorResponse(null, -32600, 'Invalid Request', protocolVersion);
	}

	const message = payload as unknown as JsonRpcRequest;
	if (typeof message.method !== 'string') {
		return acceptedMcpNotificationResponse(protocolVersion);
	}

	if (message.method === 'notifications/initialized') {
		return acceptedMcpNotificationResponse(protocolVersion);
	}

	if (message.method === 'ping') {
		if (message.id === undefined) {
			return acceptedMcpNotificationResponse(protocolVersion);
		}
		return makeJsonRpcSuccessResponse(message.id, {}, protocolVersion);
	}

	if (message.method === 'initialize') {
		if (!isRecord(message.params) || typeof message.params.protocolVersion !== 'string') {
			return makeJsonRpcErrorResponse(message.id ?? null, -32602, 'initialize requires a protocolVersion.', protocolVersion);
		}

		const requestedVersion = message.params.protocolVersion;
		if (!isSupportedMcpProtocolVersion(requestedVersion)) {
			return makeJsonRpcErrorResponse(
				message.id ?? null,
				-32602,
				'Unsupported protocol version',
				protocolVersion,
				{
					supported: [...MCP_PROTOCOL_VERSIONS],
					requested: requestedVersion,
				}
			);
		}

		return makeJsonRpcSuccessResponse(
			message.id ?? null,
			{
				protocolVersion: requestedVersion,
				capabilities: {
					tools: {},
				},
				serverInfo: {
					name: 'auth-inbox',
					title: 'Auth Inbox MCP',
					version: '1.0.0',
				},
				instructions: 'This endpoint is protected by HTTP Basic Auth. Keep the Authorization header on every MCP request.',
			},
			requestedVersion
		);
	}

	if (message.id === undefined) {
		return acceptedMcpNotificationResponse(protocolVersion);
	}

	if (message.method === 'tools/list') {
		return makeJsonRpcSuccessResponse(message.id, { tools: MCP_TOOLS }, protocolVersion);
	}

	if (message.method === 'tools/call') {
		if (!isRecord(message.params) || typeof message.params.name !== 'string') {
			return makeJsonRpcErrorResponse(message.id, -32602, 'tools/call requires a valid tool name.', protocolVersion);
		}

		const args = isRecord(message.params.arguments) ? message.params.arguments : undefined;
		try {
			const toolResult = await executeMcpTool(message.params.name, args, readLatestMailDetails);
			return makeJsonRpcSuccessResponse(message.id, makeMcpToolResult(toolResult), protocolVersion);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Tool execution failed.';
			const errorCode = errorMessage.startsWith('Tool not found:') ? -32602 : -32000;

			if (errorCode === -32602) {
				return makeJsonRpcErrorResponse(message.id, errorCode, errorMessage, protocolVersion);
			}

			return makeJsonRpcSuccessResponse(
				message.id,
				makeMcpToolResult(
					{
						error: errorMessage,
					},
					true
				),
				protocolVersion
			);
		}
	}

	return makeJsonRpcErrorResponse(message.id, -32601, `Method not found: ${message.method}`, protocolVersion);
}
