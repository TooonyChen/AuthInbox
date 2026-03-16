/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Oct 07
*/
import { WorkerEntrypoint } from "cloudflare:workers";
import { buildMcpBasicAuthConfigSnippet, handleMcpRequest, type McpMailDetail } from "./mcp";
import { RPCEmailMessage } from "./rpcEmail";

type ApiFormat = "openai" | "responses" | "anthropic";

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  format: ApiFormat;
  model: string;
}

interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  FrontEndAdminID: string;
  FrontEndAdminPassword: string;
  UseBark: string;
  barkTokens: string;
  barkUrl: string;
  // Primary AI provider
  AI_BASE_URL: string;
  AI_API_KEY: string;
  AI_API_FORMAT: ApiFormat;
  AI_MODEL: string;
  // Fallback AI provider (all four must be set to enable fallback)
  AI_FALLBACK_BASE_URL?: string;
  AI_FALLBACK_API_KEY?: string;
  AI_FALLBACK_API_FORMAT?: ApiFormat;
  AI_FALLBACK_MODEL?: string;
}

interface MailDetailRow {
  id: number;
  messageId: string | null;
  fromOrg: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  topic: string | null;
  code: string | null;
  createdAt: string | null;
  subject: string | null;
  raw: string | null;
}

interface MailDetailRecord extends MailDetailRow {
  textBody: string | null;
  htmlBody: string | null;
}

// Normalize model output into JSON text // 将模型输出规范化为可解析的 JSON 文本
function extractJsonFromText(rawText: string): Record<string, unknown> | null {
  let candidate = rawText.trim();
  const jsonMatch = candidate.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    candidate = jsonMatch[1].trim();
    console.log(`Extracted JSON Text: "${candidate}"`);
  } else {
    console.log(`Assuming entire text is JSON: "${candidate}"`);
  }

  try {
    return JSON.parse(candidate);
  } catch (parseError) {
    console.error("JSON parsing error:", parseError);
    console.log(`Problematic JSON Text: "${candidate}"`);
    return null;
  }
}

// Remove trailing slashes to avoid double separators // 移除结尾斜杠防止重复拼接
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// Unified AI provider caller supporting openai / responses / anthropic formats
async function callProvider(config: ProviderConfig, prompt: string): Promise<string | null> {
  const base = normaliseBaseUrl(config.baseUrl);
  let endpoint: string;
  let body: unknown;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (config.format === "openai") {
    endpoint = `${base}/v1/chat/completions`;
    headers["Authorization"] = `Bearer ${config.apiKey}`;
    body = {
      model: config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You return only valid JSON that matches the requested schema." },
        { role: "user", content: prompt },
      ],
    };
  } else if (config.format === "responses") {
    endpoint = `${base}/v1/responses`;
    headers["Authorization"] = `Bearer ${config.apiKey}`;
    body = {
      model: config.model,
      input: [{ role: "user", content: prompt }],
      text: { format: { type: "json_object" } },
    };
  } else {
    // anthropic
    endpoint = `${base}/v1/messages`;
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: config.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    console.error(`[callProvider:${config.format}] fetch error:`, err);
    return null;
  }

  if (!response.ok) {
    console.error(`[callProvider:${config.format}] HTTP ${response.status} ${response.statusText}`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    console.error(`[callProvider:${config.format}] failed to parse JSON response`);
    return null;
  }

  // Extract text from response based on format
  if (config.format === "openai") {
    const content = (payload as any)?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const part = content.find((p: any) => p?.type === "text" && typeof p.text === "string");
      return part?.text ?? null;
    }
    console.error("[callProvider:openai] unexpected response shape");
    return null;
  }

  if (config.format === "responses") {
    const text = (payload as any)?.output?.[0]?.content?.[0]?.text
      ?? (payload as any)?.output?.[0]?.text;
    if (typeof text === "string") return text;
    console.error("[callProvider:responses] unexpected response shape");
    return null;
  }

  // anthropic
  const text = (payload as any)?.content?.[0]?.text;
  if (typeof text === "string") return text;
  console.error("[callProvider:anthropic] unexpected response shape");
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function basicAuthUnauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": "Basic realm=\"User Visible Realm\"",
    },
  });
}

function parseBasicAuthCredentials(request: Request): { username: string; password: string } | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decodedCredentials = atob(authHeader.substring("Basic ".length));
    const separatorIndex = decodedCredentials.indexOf(":");
    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decodedCredentials.slice(0, separatorIndex),
      password: decodedCredentials.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isAdminAuthenticated(request: Request, env: Env): boolean {
  const credentials = parseBasicAuthCredentials(request);
  if (!credentials) {
    return false;
  }

  return credentials.username === env.FrontEndAdminID && credentials.password === env.FrontEndAdminPassword;
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([A-Fa-f0-9]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function stripHtmlTags(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPromotionalEmail(headers: Headers, rawEmail: string): boolean {
  // Bulk/marketing emails are legally required to carry these headers (CAN-SPAM, RFC 2369)
  if (headers.get("List-Unsubscribe") || headers.get("List-ID") || headers.get("List-Post")) {
    return true;
  }

  const precedence = headers.get("Precedence")?.toLowerCase() ?? "";
  if (precedence === "bulk" || precedence === "list") {
    return true;
  }

  // Check raw headers section for campaign/bulk markers from known ESPs
  const rawHeaders = rawEmail.slice(0, rawEmail.search(/\r?\n\r?\n/) + 1 || 4000);
  if (
    /^X-Campaign(-ID)?:/im.test(rawHeaders) ||
    /^X-Mailer:\s*(mailchimp|sendgrid|klaviyo|brevo|sendinblue|constant.contact|hubspot)/im.test(rawHeaders) ||
    /^X-SFMC-Stack:/im.test(rawHeaders) ||
    /^X-Marketo-/im.test(rawHeaders)
  ) {
    return true;
  }

  return false;
}

function extractMailBodies(rawEmail: string): { textBody: string | null; htmlBody: string | null } {
  // Try MIME multipart parsing first
  const boundaryMatch = rawEmail.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1].trim();
    const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = rawEmail.split(new RegExp(`--${escapedBoundary}(?:--)?\\r?\\n?`));

    let textBody: string | null = null;
    let htmlBody: string | null = null;

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === "--") continue;

      const headerBodyMatch = trimmed.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
      if (!headerBodyMatch) continue;

      const headers = headerBodyMatch[1];
      const body = headerBodyMatch[2].trim();
      if (!body) continue;

      const contentType = headers.match(/Content-Type:\s*([^\r\n;]+)/i)?.[1]?.trim().toLowerCase() ?? "";
      const encoding = headers.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() ?? "";

      let decoded = body;
      if (encoding === "base64") {
        try {
          decoded = atob(body.replace(/\s/g, ""));
        } catch {
          decoded = body;
        }
      } else if (encoding === "quoted-printable") {
        decoded = decodeQuotedPrintable(body);
      }

      if (contentType.includes("text/html") && !htmlBody) {
        htmlBody = decoded.trim();
      } else if (contentType.includes("text/plain") && !textBody) {
        textBody = decoded.trim();
      }
    }

    if (htmlBody || textBody) {
      if (!textBody && htmlBody) textBody = stripHtmlTags(htmlBody);
      return { textBody, htmlBody };
    }
  }

  // Fallback: no MIME boundary, try regex approach
  const htmlMatch = rawEmail.match(/<html[\s\S]*<\/html>/i) ?? rawEmail.match(/<body[\s\S]*<\/body>/i);
  const htmlBody = htmlMatch ? decodeQuotedPrintable(htmlMatch[0]).trim() : null;

  const splitParts = rawEmail.split(/\r?\n\r?\n/);
  const bodyText = splitParts.length > 1 ? splitParts.slice(1).join("\n\n") : rawEmail;
  const decodedText = decodeQuotedPrintable(bodyText).trim();
  const textBody = decodedText ? decodedText : htmlBody ? stripHtmlTags(htmlBody) : null;

  return { textBody, htmlBody };
}

function toMailDetailRecord(row: MailDetailRow): MailDetailRecord {
  const { textBody, htmlBody } = extractMailBodies(String(row.raw ?? ""));
  return {
    id: row.id,
    messageId: row.messageId,
    fromOrg: row.fromOrg,
    fromAddr: row.fromAddr,
    toAddr: row.toAddr,
    topic: row.topic,
    code: row.code,
    createdAt: row.createdAt,
    subject: row.subject ?? null,
    raw: row.raw ?? null,
    textBody,
    htmlBody,
  };
}

function toMcpMailDetail(record: MailDetailRecord): McpMailDetail {
  return {
    id: record.id,
    messageId: record.messageId,
    fromOrg: record.fromOrg,
    fromAddr: record.fromAddr,
    toAddr: record.toAddr,
    subject: record.subject,
    topic: record.topic,
    code: record.code,
    createdAt: record.createdAt,
    textBody: record.textBody,
    htmlBody: record.htmlBody,
  };
}

async function getLatestMcpMailDetails(env: Env, limit: number): Promise<McpMailDetail[]> {
  const { results } = await env.DB.prepare(
    `
      SELECT
        c.id,
        c.message_id AS messageId,
        c.from_org AS fromOrg,
        c.from_addr AS fromAddr,
        c.to_addr AS toAddr,
        c.topic,
        c.code,
        c.created_at AS createdAt,
        r.subject,
        r.raw
      FROM code_mails c
      LEFT JOIN raw_mails r ON r.message_id = c.message_id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?
    `
  )
    .bind(limit)
    .all();

  return ((results ?? []) as unknown as MailDetailRow[])
    .map(toMailDetailRecord)
    .map(toMcpMailDetail);
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env: Env = this.env;

    if (!isAdminAuthenticated(request, env)) {
      return basicAuthUnauthorizedResponse();
    }

    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, (limit) => getLatestMcpMailDetails(env, limit));
    }

    if (url.pathname === "/api/mcp/config" && request.method === "GET") {
      const mcpUrl = new URL("/mcp", request.url).toString();
      return new Response(JSON.stringify({
        mcpUrl,
        configSnippet: buildMcpBasicAuthConfigSnippet(mcpUrl),
      }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/api/mails" && request.method === "GET") {
      const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20));
      const offset = (page - 1) * pageSize;
      const { results } = await env.DB.prepare(
        `
          SELECT
            c.id,
            c.message_id AS messageId,
            c.from_org AS fromOrg,
            c.from_addr AS fromAddr,
            c.to_addr AS toAddr,
            c.topic,
            c.code,
            c.created_at AS createdAt,
            r.subject
          FROM code_mails c
          LEFT JOIN raw_mails r ON r.message_id = c.message_id
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ? OFFSET ?
        `
      )
        .bind(pageSize, offset)
        .all();

      const totalResult = await env.DB.prepare("SELECT COUNT(*) AS total FROM code_mails").first<{ total: number }>();
      return jsonResponse({
        page,
        pageSize,
        total: Number(totalResult?.total ?? 0),
        items: results ?? [],
      });
    }

    const mailDetailMatch = url.pathname.match(/^\/api\/mails\/(\d+)$/);
    if (mailDetailMatch && request.method === "GET") {
      const mailId = Number.parseInt(mailDetailMatch[1], 10);
      const row = await env.DB.prepare(
        `
          SELECT
            c.id,
            c.message_id AS messageId,
            c.from_org AS fromOrg,
            c.from_addr AS fromAddr,
            c.to_addr AS toAddr,
            c.topic,
            c.code,
            c.created_at AS createdAt,
            r.subject,
            r.raw
          FROM code_mails c
          LEFT JOIN raw_mails r ON r.message_id = c.message_id
          WHERE c.id = ?
          LIMIT 1
        `
      )
        .bind(mailId)
        .first<any>();

      if (!row) {
        return jsonResponse({ error: "Mail not found" }, 404);
      }

      const detail = toMailDetailRecord(row as MailDetailRow);
      return jsonResponse({
        id: detail.id,
        messageId: detail.messageId,
        fromOrg: detail.fromOrg,
        fromAddr: detail.fromAddr,
        toAddr: detail.toAddr,
        topic: detail.topic,
        code: detail.code,
        createdAt: detail.createdAt,
        subject: detail.subject,
        raw: detail.raw,
        textBody: detail.textBody,
        htmlBody: detail.htmlBody,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const indexRequest = new Request(new URL("/index.html", request.url).toString(), request);
        const indexResponse = await env.ASSETS.fetch(indexRequest);
        if (indexResponse.status !== 404) {
          return indexResponse;
        }
      }
    }

    return new Response("ASSETS binding is required to serve the frontend.", { status: 500 });
  }

  // Primary email handler // 主要邮件处理入口
  async email(message: ForwardableEmailMessage): Promise<void> {
    const env: Env = this.env;
    const useBark = env.UseBark.toLowerCase() === "true";

    const primary: ProviderConfig = {
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      format: env.AI_API_FORMAT ?? "openai",
      model: env.AI_MODEL,
    };

    const fallback: ProviderConfig | null =
      env.AI_FALLBACK_BASE_URL && env.AI_FALLBACK_API_KEY && env.AI_FALLBACK_MODEL
        ? {
            baseUrl: env.AI_FALLBACK_BASE_URL,
            apiKey: env.AI_FALLBACK_API_KEY,
            format: env.AI_FALLBACK_API_FORMAT ?? "openai",
            model: env.AI_FALLBACK_MODEL,
          }
        : null;

    // Pull raw email content // 获取原始邮件内容
    const rawEmail =
      message instanceof RPCEmailMessage
        ? (message as RPCEmailMessage).rawEmail
        : await new Response(message.raw).text();
    const messageId = message.headers.get("Message-ID");
    const rawSubject = message.headers.get("Subject");

    // Persist raw mail payload for auditing // 将原始邮件持久化以便审计
    const { success } = await env.DB.prepare(
      "INSERT INTO raw_mails (from_addr, to_addr, subject, raw, message_id) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(message.from, message.to, rawSubject, rawEmail, messageId)
      .run();

    if (!success) {
      message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
      console.log(`Failed to save message from ${message.from} to ${message.to}`);
    }

    // Skip promotional/bulk emails before hitting the LLM
    if (isPromotionalEmail(message.headers, rawEmail)) {
      console.log(`Skipping promotional email from ${message.from}: ${rawSubject}`);
      return;
    }

    // Prompt instructs model how to format extraction // 提示词说明提取格式和字段要求
    const aiPrompt = `
  Email content: ${rawEmail}.

  Please read the email and extract the following information:
  1. Code/Link/Password from the email (if available).
  2. Organization name (title) from which the email is sent.
  3. A brief summary of the email's topic (e.g., 'line register verification').

  Please provide the following information in JSON format:
  {
    "title": "The organization or company that sent the verification code (e.g., 'Netflix')",
    "code": "The extracted verification code, link, or password (e.g., '123456' or 'https://example.com/verify?code=123456')",
    "topic": "A brief summary of the email's topic (e.g., 'line register verification')",
    "codeExist": 1
  }


  If both a code and a link are present, include both in the 'code' field like this:
  "code": "code, link"

  If there is no code, clickable link, or this is an advertisement email, return:
  {
    "codeExist": 0
  }
`;

    try {
      const maxRetries = 3;
      let extractedData: Record<string, unknown> | null = null;

      // Primary provider: up to 3 attempts
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[primary:${primary.format}] attempt ${attempt}`);
        const text = await callProvider(primary, aiPrompt);
        if (text) {
          const parsed = extractJsonFromText(text);
          if (parsed) {
            extractedData = parsed;
            console.log("[primary] extracted data:", extractedData);
            break;
          }
        }
        if (attempt < maxRetries) console.log("[primary] retrying...");
        else console.error("[primary] max retries reached");
      }

      // Fallback provider: one attempt if primary produced nothing and fallback is configured
      if (!extractedData && fallback) {
        console.log(`[fallback:${fallback.format}] attempting`);
        const text = await callProvider(fallback, aiPrompt);
        if (text) {
          const parsed = extractJsonFromText(text);
          if (parsed) {
            extractedData = parsed;
            console.log("[fallback] extracted data:", extractedData);
          } else {
            console.error("[fallback] failed to parse response");
          }
        } else {
          console.error("[fallback] provider returned nothing");
        }
      } else if (!extractedData) {
        console.error("[primary] failed and no fallback configured");
      }

      if (extractedData) {
        // Only persist when a code exists // 仅在存在验证码时写入数据库
        if ((extractedData as any).codeExist === 1) {
          const title = (extractedData as any).title || "Unknown Organization";
          const code = (extractedData as any).code || "No Code Found";
          const topic = (extractedData as any).topic || "No Topic Found";

          // Store parsed metadata for UI display // 保存解析结果供前端展示
          const { success: codeMailSuccess } = await env.DB.prepare(
            "INSERT INTO code_mails (from_addr, from_org, to_addr, code, topic, message_id) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(message.from, title, message.to, code, topic, messageId)
            .run();

          if (!codeMailSuccess) {
            message.setReject(
              `Failed to save extracted code for message from ${message.from} to ${message.to}`
            );
            console.log(
              `Failed to save extracted code for message from ${message.from} to ${message.to}`
            );
          }

          if (useBark) {
            // Fan-out Bark notifications for each token // 为每个 token 发送 Bark 推送
            const barkUrl = env.barkUrl;
            const barkTokens = env.barkTokens
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((token) => token.trim());

            const barkUrlEncodedTitle = encodeURIComponent(title);
            const barkUrlEncodedCode = encodeURIComponent(code);

            for (const token of barkTokens) {
              const barkRequestUrl = `${barkUrl}/${token}/${barkUrlEncodedTitle}/${barkUrlEncodedCode}`;

              const barkResponse = await fetch(barkRequestUrl, {
                method: "GET",
              });

              if (barkResponse.ok) {
                console.log(
                  `Successfully sent notification to Bark for token ${token} for message from ${message.from} to ${message.to}`
                );
                const responseData = await barkResponse.json();
                console.log("Bark response:", responseData);
              } else {
                console.error(
                  `Failed to send notification to Bark for token ${token}: ${barkResponse.status} ${barkResponse.statusText}`
                );
              }
            }
          }
        } else {
          console.log("No code found in this email, skipping Bark notification.");
        }
      } else {
        console.error("Failed to extract data from AI response after retries.");
      }
    } catch (e) {
      console.error("Error calling AI or saving to database:", e);
    }
  }

  // Expose RPC helper for other workers // 暴露 RPC 接口供其他 Worker 调用
  async rpcEmail(requestBody: string): Promise<void> {
    console.log(`Received RPC email , request body: ${requestBody}`);
    const bodyObject = JSON.parse(requestBody) as {
      from: string;
      to: string;
      rawEmail: string;
      headers: Record<string, string>;
    };
    const headersObject = bodyObject.headers;
    const headers = new Headers(headersObject);
    const rpcEmailMessage: RPCEmailMessage = new RPCEmailMessage(
      bodyObject.from,
      bodyObject.to,
      bodyObject.rawEmail,
      headers
    );
    await this.email(rpcEmailMessage);
  }
}
