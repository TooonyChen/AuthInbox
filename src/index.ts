/*
index.ts
This is the main file for the Auth Inbox Email Worker.
created by: github@TooonyChen
created on: 2024 Oct 07
Last updated: 2024 Oct 07
*/
import { WorkerEntrypoint } from "cloudflare:workers";
import { RPCEmailMessage } from "./rpcEmail";

import indexHtml from "./index.html";

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

const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
};

const HARDENING_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const MAX_PROMPT_BODY_LENGTH = 8000;

function applyHardeningHeaders(
  headers: HeadersInit,
  options: { noStore?: boolean } = {}
): Headers {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(HARDENING_HEADERS)) {
    merged.set(key, value);
  }
  if (options.noStore ?? true) {
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
      merged.set(key, value);
    }
  }
  return merged;
}

function toSecureResponse(
  body: BodyInit | null,
  init: ResponseInit = {},
  options: { noStore?: boolean } = {}
): Response {
  return new Response(body, {
    ...init,
    headers: applyHardeningHeaders(init.headers ?? {}, options),
  });
}

function unauthorizedResponse(): Response {
  return toSecureResponse("Unauthorized", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": "Basic realm=\"User Visible Realm\"",
    },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function fixedTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

export function parseBasicAuthCredentials(
  authHeader: string | null
): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }

  const encodedCredentials = authHeader.substring("Basic ".length).trim();
  if (!encodedCredentials) {
    return null;
  }

  let decodedCredentials: string;
  try {
    decodedCredentials = atob(encodedCredentials);
  } catch {
    return null;
  }

  const separatorIndex = decodedCredentials.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    username: decodedCredentials.slice(0, separatorIndex),
    password: decodedCredentials.slice(separatorIndex + 1),
  };
}

export function isAuthorizedBasicAuth(
  authHeader: string | null,
  expectedUsername: string,
  expectedPassword: string
): boolean {
  const credentials = parseBasicAuthCredentials(authHeader);
  if (!credentials) {
    return false;
  }

  return (
    fixedTimeEquals(credentials.username, expectedUsername)
    && fixedTimeEquals(credentials.password, expectedPassword)
  );
}

function normalisePromptText(value: string): string {
  return value.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s+/g, " ").trim();
}

export function buildAiPrompt(params: {
  from: string;
  to: string;
  subject: string;
  textBody: string;
}): string {
  const emailBody = normalisePromptText(params.textBody).slice(0, MAX_PROMPT_BODY_LENGTH);
  const subject = normalisePromptText(params.subject).slice(0, 300);

  return `
Email metadata:
- From: ${params.from}
- To: ${params.to}
- Subject: ${subject || "(no subject)"}

Email text content:
${emailBody || "(empty body)"}

Please extract:
1. Verification code / password / magic link.
2. Sender organization name.
3. A short topic summary.

Return strict JSON:
{
  "title": "Sender organization",
  "code": "verification code, link, or password",
  "topic": "short summary",
  "codeExist": 1
}

If both code and link exist:
"code": "code, link"

If there is no verification code/password/clickable link:
{
  "codeExist": 0
}
`;
}

export function summarizeExtractionForLog(payload: Record<string, unknown>): string {
  const codeExistValue = payload.codeExist;
  const codeExist =
    typeof codeExistValue === "number" || typeof codeExistValue === "string"
      ? String(codeExistValue)
      : "unknown";
  return `codeExist=${codeExist}`;
}

interface LegacyMailRow {
  from_org: string | null;
  to_addr: string | null;
  topic: string | null;
  code: string | null;
  created_at: string | null;
}

export function buildLegacyCodeCell(codeValue: string | null, topicValue: string | null): string {
  const codeText = (codeValue ?? "").trim();
  const topic = escapeHtml((topicValue ?? "").trim() || "Open Link");

  if (!codeText) return "-";

  const commaParts = codeText.split(",");
  if (commaParts.length > 1) {
    const codePart = escapeHtml(commaParts[0]?.trim() ?? "");
    const linkPart = commaParts.slice(1).join(",").trim();
    const safeLink = sanitizeHttpUrl(linkPart);
    if (safeLink) {
      return `${codePart}<br><a href="${escapeHtml(safeLink)}" target="_blank" rel="noopener noreferrer">${topic}</a>`;
    }
    return codePart || "-";
  }

  const standaloneLink = sanitizeHttpUrl(codeText);
  if (standaloneLink) {
    return `<a href="${escapeHtml(standaloneLink)}" target="_blank" rel="noopener noreferrer">${topic}</a>`;
  }

  return escapeHtml(codeText);
}

function buildLegacyTableRow(row: LegacyMailRow): string {
  return `<tr>
                    <td>${escapeHtml(String(row.from_org ?? "-"))}</td>
                    <td>${escapeHtml(String(row.to_addr ?? "-"))}</td>
                    <td>${escapeHtml(String(row.topic ?? "-"))}</td>
                    <td>${buildLegacyCodeCell(row.code, row.topic)}</td>
                    <td>${escapeHtml(String(row.created_at ?? "-"))}</td>
                </tr>`;
}

// Normalize model output into JSON text // 将模型输出规范化为可解析的 JSON 文本
function extractJsonFromText(rawText: string): Record<string, unknown> | null {
  let candidate = rawText.trim();
  const jsonMatch = candidate.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    candidate = jsonMatch[1].trim();
    console.log(`Extracted JSON payload, length=${candidate.length}`);
  } else {
    console.log(`Attempting to parse provider output as JSON, length=${candidate.length}`);
  }

  try {
    return JSON.parse(candidate);
  } catch (parseError) {
    console.error("JSON parsing error:", parseError);
    console.log(`Invalid JSON payload length=${candidate.length}`);
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
  return toSecureResponse(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
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

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env: Env = this.env;
    const FrontEndAdminID = env.FrontEndAdminID;
    const FrontEndAdminPassword = env.FrontEndAdminPassword;

    // Basic-auth gate for the admin console // 使用 Basic Auth 保护管理界面
    const authHeader = request.headers.get("Authorization");
    if (!isAuthorizedBasicAuth(authHeader, FrontEndAdminID, FrontEndAdminPassword)) {
      return unauthorizedResponse();
    }

    const url = new URL(request.url);

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
          ORDER BY c.created_at DESC
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

      const { textBody, htmlBody } = extractMailBodies(String(row.raw ?? ""));
      return jsonResponse({
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
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return toSecureResponse(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers: assetResponse.headers,
        }, { noStore: false });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const indexRequest = new Request(new URL("/index.html", request.url).toString(), request);
        const indexResponse = await env.ASSETS.fetch(indexRequest);
        if (indexResponse.status !== 404) {
          return toSecureResponse(indexResponse.body, {
            status: indexResponse.status,
            statusText: indexResponse.statusText,
            headers: indexResponse.headers,
          }, { noStore: false });
        }
      }
    }

    try {
      const { results } = await env.DB.prepare(
        "SELECT from_org, to_addr, topic, code, created_at FROM code_mails ORDER BY created_at DESC"
      ).all<LegacyMailRow>();

      let dataHtml = "";
      for (const row of results) {
        dataHtml += buildLegacyTableRow(row);
      }

      const responseHtml = indexHtml
        .replace(
          "{{TABLE_HEADERS}}",
          `
                    <tr>
                        <th>From</th>
                        <th>To</th>
                        <th>Topic</th>
                        <th>Code/Link</th>
                        <th>Receive Time (GMT)</th>
                    </tr>
                `
        )
        .replace("{{DATA}}", dataHtml);

      return toSecureResponse(responseHtml, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    } catch (error) {
      console.error("Error querying database:", error);
      return toSecureResponse("Internal Server Error", {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
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
    const rawEmail: string =
      message instanceof RPCEmailMessage
        ? (message as RPCEmailMessage).rawEmail
        : await new Response(message.raw).text();
    const messageId = message.headers.get("Message-ID");
    const rawSubject = message.headers.get("Subject");
    const { textBody } = extractMailBodies(rawEmail);

    // Persist raw mail payload for auditing // 将原始邮件持久化以便审计
    const { success } = await env.DB.prepare(
      "INSERT INTO raw_mails (from_addr, to_addr, subject, raw, message_id) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(message.from, message.to, rawSubject, rawEmail, messageId)
      .run();

    if (!success) {
      message.setReject("Failed to save message payload");
      console.log(`Failed to save raw mail payload for messageId=${messageId ?? "unknown"}`);
    }

    // Skip promotional/bulk emails before hitting the LLM
    if (isPromotionalEmail(message.headers, rawEmail)) {
      console.log(`Skipping promotional email messageId=${messageId ?? "unknown"}`);
      return;
    }

    // Prompt instructs model how to format extraction // 提示词说明提取格式和字段要求
    const aiPrompt = buildAiPrompt({
      from: message.from,
      to: message.to,
      subject: rawSubject ?? "",
      textBody: textBody ?? stripHtmlTags(rawEmail).slice(0, MAX_PROMPT_BODY_LENGTH),
    });

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
            console.log(`[primary] extracted fields: ${summarizeExtractionForLog(parsed)}`);
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
            console.log(`[fallback] extracted fields: ${summarizeExtractionForLog(parsed)}`);
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
            message.setReject("Failed to save extracted code payload");
            console.log(
              `Failed to save extracted code for messageId=${messageId ?? "unknown"}`
            );
          }

          if (useBark) {
            // Fan-out Bark notifications for each token // 为每个 token 发送 Bark 推送
            const barkUrl = env.barkUrl;
            const barkTokens = env.barkTokens
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((token) => token.trim())
              .filter(Boolean);

            const barkUrlEncodedTitle = encodeURIComponent(title);
            const barkUrlEncodedCode = encodeURIComponent(code);

            for (const [index, token] of barkTokens.entries()) {
              const barkRequestUrl = `${barkUrl}/${token}/${barkUrlEncodedTitle}/${barkUrlEncodedCode}`;

              const barkResponse = await fetch(barkRequestUrl, {
                method: "GET",
              });

              if (barkResponse.ok) {
                console.log(
                  `Successfully sent Bark notification ${index + 1}/${barkTokens.length} for messageId=${messageId ?? "unknown"}`
                );
              } else {
                console.error(
                  `Failed Bark notification ${index + 1}/${barkTokens.length}: ${barkResponse.status} ${barkResponse.statusText}`
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
    console.log("Received RPC email request");
    let bodyObject: {
      from?: string;
      to?: string;
      rawEmail?: string;
      headers?: Record<string, string>;
    };

    try {
      bodyObject = JSON.parse(requestBody);
    } catch {
      console.error("rpcEmail received invalid JSON");
      return;
    }

    if (
      typeof bodyObject.from !== "string"
      || typeof bodyObject.to !== "string"
      || typeof bodyObject.rawEmail !== "string"
    ) {
      console.error("rpcEmail missing required fields");
      return;
    }

    const headers = new Headers(bodyObject.headers ?? {});
    const rpcEmailMessage: RPCEmailMessage = new RPCEmailMessage(
      bodyObject.from,
      bodyObject.to,
      bodyObject.rawEmail,
      headers
    );
    await this.email(rpcEmailMessage);
  }
}
