import { describe, expect, it } from 'vitest';
import { buildMcpBasicAuthConfigSnippet, handleMcpRequest, type McpMailDetail } from '../src/mcp';

const sampleMails: McpMailDetail[] = [
	{
		id: 11,
		messageId: 'msg-11',
		fromOrg: 'Example App',
		fromAddr: 'no-reply@example.com',
		toAddr: 'user@example.com',
		subject: 'Your verification code',
		topic: 'login verification',
		code: '123456',
		createdAt: '2026-03-17T10:00:00.000Z',
		textBody: 'Your code is 123456.',
		htmlBody: '<p>Your code is <strong>123456</strong>.</p>',
	},
	{
		id: 10,
		messageId: 'msg-10',
		fromOrg: 'Second App',
		fromAddr: 'hello@second.com',
		toAddr: 'user@example.com',
		subject: 'Magic link',
		topic: 'signin link',
		code: 'https://second.com/login',
		createdAt: '2026-03-17T09:00:00.000Z',
		textBody: 'Open https://second.com/login',
		htmlBody: '<a href="https://second.com/login">Sign in</a>',
	},
];

async function readLatestMailDetails(limit: number): Promise<McpMailDetail[]> {
	return sampleMails.slice(0, limit);
}

describe('mcp transport', () => {
	it('returns initialize metadata', async () => {
		const request = new Request('https://authinbox.test/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: {
						name: 'vitest',
						version: '1.0.0',
					},
				},
			}),
		});

		const response = await handleMcpRequest(request, readLatestMailDetails);
		const payload = await response.json<{
			result: {
				protocolVersion: string;
				serverInfo: { name: string };
			};
		}>();

		expect(response.status).toBe(200);
		expect(payload.result.protocolVersion).toBe('2025-06-18');
		expect(payload.result.serverInfo.name).toBe('auth-inbox');
	});

	it('returns the latest mail via get_latest_mail', async () => {
		const request = new Request('https://authinbox.test/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2025-06-18',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/call',
				params: {
					name: 'get_latest_mail',
					arguments: {},
				},
			}),
		});

		const response = await handleMcpRequest(request, readLatestMailDetails);
		const payload = await response.json<{
			result: {
				structuredContent: {
					mail: McpMailDetail;
				};
			};
		}>();

		expect(response.status).toBe(200);
		expect(payload.result.structuredContent.mail.id).toBe(11);
		expect(payload.result.structuredContent.mail.code).toBe('123456');
	});

	it('returns multiple mails with the requested limit', async () => {
		const request = new Request('https://authinbox.test/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'MCP-Protocol-Version': '2025-06-18',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'get_multiple_mail',
					arguments: {
						limit: 2,
					},
				},
			}),
		});

		const response = await handleMcpRequest(request, readLatestMailDetails);
		const payload = await response.json<{
			result: {
				structuredContent: {
					limit: number;
					count: number;
					mails: McpMailDetail[];
				};
			};
		}>();

		expect(response.status).toBe(200);
		expect(payload.result.structuredContent.limit).toBe(2);
		expect(payload.result.structuredContent.count).toBe(2);
		expect(payload.result.structuredContent.mails).toHaveLength(2);
	});

	it('builds a config snippet with Authorization header', () => {
		const config = JSON.parse(
			buildMcpBasicAuthConfigSnippet('https://authinbox.test/mcp')
		) as {
			mcpServers: {
				authInbox: {
					url: string;
					headers: {
						Authorization: string;
					};
				};
			};
		};

		expect(config.mcpServers.authInbox.url).toBe('https://authinbox.test/mcp');
		expect(config.mcpServers.authInbox.headers.Authorization).toBe('Basic <base64(username:password)>');
	});
});
