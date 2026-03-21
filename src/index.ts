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
type DensityMode = "default" | "comfortable" | "compact";
type ReadingPaneMode = "none" | "right" | "bottom";
type ThemeMode = "dark" | "light" | "system";

type ThreadAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "unarchive"
  | "delete"
  | "restore"
  | "important"
  | "not-important"
  | "snooze"
  | "label-add"
  | "label-remove";

type MailCategory = "primary" | "social" | "promotions" | "updates" | "forums";

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

interface UiSettingsRow {
  density: DensityMode;
  reading_pane: ReadingPaneMode;
  theme: ThemeMode;
  shortcuts_enabled: number;
}

interface ThreadQueryResultRow {
  rawId: number;
  messageId: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  subject: string | null;
  raw: string | null;
  createdAt: string | null;
  fromOrg: string | null;
  topic: string | null;
  code: string | null;
  isRead: number | null;
  isStarred: number | null;
  isArchived: number | null;
  isDeleted: number | null;
  isImportant: number | null;
  isMuted: number | null;
  category: string | null;
  labelsJson: string | null;
  snoozedUntil: string | null;
}

interface SearchTokens {
  from: string[];
  to: string[];
  subject: string[];
  text: string[];
  categories: MailCategory[];
  inMailbox: Array<"inbox" | "archive" | "trash" | "anywhere" | "snoozed">;
  isFlags: Array<"read" | "unread" | "starred" | "important" | "muted">;
  hasFlags: Array<"attachment">;
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
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const CATEGORY_VALUES: MailCategory[] = ["primary", "social", "promotions", "updates", "forums"];
const DENSITY_VALUES: DensityMode[] = ["default", "comfortable", "compact"];
const READING_PANE_VALUES: ReadingPaneMode[] = ["none", "right", "bottom"];
const THEME_VALUES: ThemeMode[] = ["dark", "light", "system"];
const SQL_CATEGORY_EXPRESSION = `
COALESCE(
  ms.category,
  CASE
    WHEN LOWER(COALESCE(r.from_addr, '')) LIKE '%facebook%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%twitter%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%linkedin%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%instagram%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%mentioned you%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%new follower%'
    THEN 'social'
    WHEN LOWER(COALESCE(r.from_addr, '')) LIKE '%forum%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%community%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%forum%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%thread%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%discussion%'
    THEN 'forums'
    WHEN LOWER(COALESCE(r.subject, '')) LIKE '%invoice%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%receipt%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%order%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%shipment%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%statement%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%payment%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%security%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%alert%'
    THEN 'updates'
    WHEN LOWER(COALESCE(r.from_addr, '')) LIKE '%newsletter%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%promo%'
      OR LOWER(COALESCE(r.from_addr, '')) LIKE '%marketing%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%sale%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%discount%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%offer%'
      OR LOWER(COALESCE(r.subject, '')) LIKE '%coupon%'
    THEN 'promotions'
    ELSE 'primary'
  END
)
`;

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

function clampPage(value: string | null, fallback = 1): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function clampPageSize(value: string | null, fallback = DEFAULT_PAGE_SIZE): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
}

function sanitizeDensityMode(value: string | null | undefined): DensityMode {
  if (value && DENSITY_VALUES.includes(value as DensityMode)) {
    return value as DensityMode;
  }
  return "default";
}

function sanitizeReadingPaneMode(value: string | null | undefined): ReadingPaneMode {
  if (value && READING_PANE_VALUES.includes(value as ReadingPaneMode)) {
    return value as ReadingPaneMode;
  }
  return "right";
}

function sanitizeThemeMode(value: string | null | undefined): ThemeMode {
  if (value && THEME_VALUES.includes(value as ThemeMode)) {
    return value as ThemeMode;
  }
  return "dark";
}

function sanitizeCategory(value: string | null | undefined): MailCategory {
  if (value && CATEGORY_VALUES.includes(value as MailCategory)) {
    return value as MailCategory;
  }
  return "primary";
}

function parseLabels(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}

function stringifyLabels(labels: string[]): string {
  return JSON.stringify(Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean))).slice(0, 50));
}

export function inferCategoryFromFields(fromAddr: string | null, subject: string | null): MailCategory {
  const from = (fromAddr ?? "").toLowerCase();
  const normalizedSubject = (subject ?? "").toLowerCase();

  if (
    from.includes("facebook")
    || from.includes("twitter")
    || from.includes("linkedin")
    || from.includes("instagram")
    || from.includes("tiktok")
    || from.includes("discord")
    || normalizedSubject.includes("new follower")
    || normalizedSubject.includes("mentioned you")
  ) {
    return "social";
  }

  if (
    from.includes("forum")
    || from.includes("community")
    || from.includes("groups")
    || from.includes("discourse")
    || normalizedSubject.includes("thread")
    || normalizedSubject.includes("discussion")
    || normalizedSubject.includes("forum")
  ) {
    return "forums";
  }

  if (
    normalizedSubject.includes("invoice")
    || normalizedSubject.includes("receipt")
    || normalizedSubject.includes("order")
    || normalizedSubject.includes("shipment")
    || normalizedSubject.includes("statement")
    || normalizedSubject.includes("payment")
    || normalizedSubject.includes("alert")
    || normalizedSubject.includes("security")
  ) {
    return "updates";
  }

  if (
    from.includes("newsletter")
    || from.includes("marketing")
    || from.includes("promo")
    || from.includes("deals")
    || normalizedSubject.includes("sale")
    || normalizedSubject.includes("discount")
    || normalizedSubject.includes("offer")
    || normalizedSubject.includes("coupon")
  ) {
    return "promotions";
  }

  return "primary";
}

function tokenizeSearchQuery(input: string): string[] {
  const pattern = /([a-z]+:"[^"]+"|[a-z]+:[^\s]+|"[^"]+"|\S+)/gi;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const token = (match[1] ?? "").trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function normalizeTokenValue(value: string): string {
  return value.replace(/^"|"$/g, "").trim().toLowerCase();
}

export function parseSearchTokens(rawQuery: string): SearchTokens {
  const parsed: SearchTokens = {
    from: [],
    to: [],
    subject: [],
    text: [],
    categories: [],
    inMailbox: [],
    isFlags: [],
    hasFlags: [],
  };

  const tokens = tokenizeSearchQuery(rawQuery);
  for (const originalToken of tokens) {
    const separator = originalToken.indexOf(":");
    if (separator <= 0) {
      parsed.text.push(normalizeTokenValue(originalToken));
      continue;
    }

    const key = originalToken.slice(0, separator).toLowerCase().trim();
    const value = normalizeTokenValue(originalToken.slice(separator + 1));
    if (!value) {
      continue;
    }

    if (key === "from") {
      parsed.from.push(value);
      continue;
    }
    if (key === "to") {
      parsed.to.push(value);
      continue;
    }
    if (key === "subject") {
      parsed.subject.push(value);
      continue;
    }
    if (key === "category") {
      if (CATEGORY_VALUES.includes(value as MailCategory)) {
        parsed.categories.push(value as MailCategory);
      }
      continue;
    }
    if (key === "in") {
      if (["inbox", "archive", "trash", "anywhere", "snoozed"].includes(value)) {
        parsed.inMailbox.push(value as SearchTokens["inMailbox"][number]);
      }
      continue;
    }
    if (key === "is") {
      if (["read", "unread", "starred", "important", "muted"].includes(value)) {
        parsed.isFlags.push(value as SearchTokens["isFlags"][number]);
      }
      continue;
    }
    if (key === "has") {
      if (value === "attachment") {
        parsed.hasFlags.push("attachment");
      }
      continue;
    }
    parsed.text.push(value);
  }

  return parsed;
}

function escapeSqlLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function normaliseSnippet(value: string | null): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function ensureGmailUiTables(db: D1Database): Promise<void> {
  await db.prepare(
    `
      CREATE TABLE IF NOT EXISTS mail_states (
        raw_id INTEGER PRIMARY KEY,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        is_important INTEGER NOT NULL DEFAULT 0,
        is_muted INTEGER NOT NULL DEFAULT 0,
        category TEXT,
        labels_json TEXT,
        snoozed_until DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (raw_id) REFERENCES raw_mails(id) ON DELETE CASCADE
      )
    `
  ).run();

  await db.prepare(
    `
      CREATE TABLE IF NOT EXISTS ui_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        density TEXT NOT NULL DEFAULT 'default',
        reading_pane TEXT NOT NULL DEFAULT 'right',
        theme TEXT NOT NULL DEFAULT 'dark',
        shortcuts_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `
  ).run();

  await db.prepare(
    `
      INSERT OR IGNORE INTO ui_settings (id, density, reading_pane, theme, shortcuts_enabled)
      VALUES (1, 'default', 'right', 'dark', 1)
    `
  ).run();

  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_states_archived ON mail_states (is_archived, updated_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_states_deleted ON mail_states (is_deleted, updated_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_states_read ON mail_states (is_read, updated_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_states_starred ON mail_states (is_starred, updated_at DESC)").run();
}

async function getUiSettings(db: D1Database): Promise<{
  density: DensityMode;
  readingPane: ReadingPaneMode;
  theme: ThemeMode;
  shortcutsEnabled: boolean;
}> {
  const row = await db.prepare(
    `
      SELECT density, reading_pane, theme, shortcuts_enabled
      FROM ui_settings
      WHERE id = 1
      LIMIT 1
    `
  ).first<UiSettingsRow>();

  return {
    density: sanitizeDensityMode(row?.density ?? null),
    readingPane: sanitizeReadingPaneMode(row?.reading_pane ?? null),
    theme: sanitizeThemeMode(row?.theme ?? null),
    shortcutsEnabled: Number(row?.shortcuts_enabled ?? 1) === 1,
  };
}

async function upsertUiSettings(
  db: D1Database,
  payload: Partial<{
    density: DensityMode;
    readingPane: ReadingPaneMode;
    theme: ThemeMode;
    shortcutsEnabled: boolean;
  }>
): Promise<void> {
  const current = await getUiSettings(db);
  const density = sanitizeDensityMode(payload.density ?? current.density);
  const readingPane = sanitizeReadingPaneMode(payload.readingPane ?? current.readingPane);
  const theme = sanitizeThemeMode(payload.theme ?? current.theme);
  const shortcutsEnabled = payload.shortcutsEnabled ?? current.shortcutsEnabled;

  await db.prepare(
    `
      INSERT INTO ui_settings (id, density, reading_pane, theme, shortcuts_enabled, updated_at)
      VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        density = excluded.density,
        reading_pane = excluded.reading_pane,
        theme = excluded.theme,
        shortcuts_enabled = excluded.shortcuts_enabled,
        updated_at = CURRENT_TIMESTAMP
    `
  )
    .bind(density, readingPane, theme, shortcutsEnabled ? 1 : 0)
    .run();
}

async function ensureMailStateRows(db: D1Database, rawIds: number[]): Promise<void> {
  for (const rawId of rawIds) {
    await db.prepare("INSERT OR IGNORE INTO mail_states (raw_id) VALUES (?)").bind(rawId).run();
  }
}

function parseRawHeaders(rawEmail: string): Headers {
  const headers = new Headers();
  const headerBlock = rawEmail.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const lines = headerBlock.split(/\r?\n/);
  let currentName: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName) {
      const previous = headers.get(currentName) ?? "";
      headers.set(currentName, `${previous} ${line.trim()}`.trim());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      currentName = null;
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    currentName = key;
    headers.set(key, value);
  }
  return headers;
}

function computeCategory(row: ThreadQueryResultRow): MailCategory {
  if (row.category && CATEGORY_VALUES.includes(row.category as MailCategory)) {
    return row.category as MailCategory;
  }

  if (row.raw) {
    const headers = parseRawHeaders(row.raw);
    if (isPromotionalEmail(headers, row.raw)) {
      return "promotions";
    }
  }

  return inferCategoryFromFields(row.fromAddr, row.subject);
}

function buildThreadSnippet(row: ThreadQueryResultRow): string {
  const { textBody } = extractMailBodies(String(row.raw ?? ""));
  if (textBody) {
    return normaliseSnippet(textBody);
  }
  return normaliseSnippet(row.topic ?? row.subject ?? null);
}

function resolveWhereClause(options: {
  tokens: SearchTokens;
  categoryFilter: string | null;
  includeDeleted: boolean;
  includeArchived: boolean;
}): { clauses: string[]; bindings: Array<string | number> } {
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];
  const { tokens } = options;

  if (!options.includeDeleted) {
    clauses.push("COALESCE(ms.is_deleted, 0) = 0");
  }
  if (!options.includeArchived) {
    clauses.push("COALESCE(ms.is_archived, 0) = 0");
  }

  if (options.categoryFilter && options.categoryFilter !== "all") {
    clauses.push(`${SQL_CATEGORY_EXPRESSION} = ?`);
    bindings.push(options.categoryFilter);
  }

  for (const fromToken of tokens.from) {
    clauses.push("LOWER(COALESCE(r.from_addr, '')) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeSqlLike(fromToken)}%`);
  }

  for (const toToken of tokens.to) {
    clauses.push("LOWER(COALESCE(r.to_addr, '')) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeSqlLike(toToken)}%`);
  }

  for (const subjectToken of tokens.subject) {
    clauses.push("LOWER(COALESCE(r.subject, '')) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeSqlLike(subjectToken)}%`);
  }

  for (const isToken of tokens.isFlags) {
    if (isToken === "read") clauses.push("COALESCE(ms.is_read, 0) = 1");
    if (isToken === "unread") clauses.push("COALESCE(ms.is_read, 0) = 0");
    if (isToken === "starred") clauses.push("COALESCE(ms.is_starred, 0) = 1");
    if (isToken === "important") clauses.push("COALESCE(ms.is_important, 0) = 1");
    if (isToken === "muted") clauses.push("COALESCE(ms.is_muted, 0) = 1");
  }

  for (const inToken of tokens.inMailbox) {
    if (inToken === "inbox") {
      clauses.push("COALESCE(ms.is_archived, 0) = 0");
      clauses.push("COALESCE(ms.is_deleted, 0) = 0");
    }
    if (inToken === "archive") {
      clauses.push("COALESCE(ms.is_archived, 0) = 1");
      clauses.push("COALESCE(ms.is_deleted, 0) = 0");
    }
    if (inToken === "trash") {
      clauses.push("COALESCE(ms.is_deleted, 0) = 1");
    }
    if (inToken === "snoozed") {
      clauses.push("ms.snoozed_until IS NOT NULL");
      clauses.push("ms.snoozed_until > CURRENT_TIMESTAMP");
    }
  }

  for (const hasToken of tokens.hasFlags) {
    if (hasToken === "attachment") {
      clauses.push("LOWER(COALESCE(r.raw, '')) LIKE '%content-disposition: attachment%'");
    }
  }

  for (const categoryToken of tokens.categories) {
    clauses.push(`${SQL_CATEGORY_EXPRESSION} = ?`);
    bindings.push(categoryToken);
  }

  for (const textToken of tokens.text) {
    const likeTerm = `%${escapeSqlLike(textToken)}%`;
    clauses.push(
      "(LOWER(COALESCE(r.subject, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(r.from_addr, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(r.to_addr, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.topic, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.from_org, '')) LIKE ? ESCAPE '\\')"
    );
    bindings.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
  }

  return { clauses, bindings };
}

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
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

    if (url.pathname.startsWith("/api/v2/")) {
      await ensureGmailUiTables(env.DB);

      if (url.pathname === "/api/v2/settings" && request.method === "GET") {
        return jsonResponse(await getUiSettings(env.DB));
      }

      if (url.pathname === "/api/v2/settings" && request.method === "PUT") {
        const payload = await parseJsonBody<{
          density?: string;
          readingPane?: string;
          theme?: string;
          shortcutsEnabled?: boolean;
        }>(request);
        if (!payload || typeof payload !== "object") {
          return jsonResponse({ error: "Invalid settings payload" }, 400);
        }

        await upsertUiSettings(env.DB, {
          density: sanitizeDensityMode(payload.density),
          readingPane: sanitizeReadingPaneMode(payload.readingPane),
          theme: sanitizeThemeMode(payload.theme),
          shortcutsEnabled:
            typeof payload.shortcutsEnabled === "boolean" ? payload.shortcutsEnabled : undefined,
        });
        return jsonResponse(await getUiSettings(env.DB));
      }

      if (url.pathname === "/api/v2/threads" && request.method === "GET") {
        const page = clampPage(url.searchParams.get("page"), 1);
        const pageSize = clampPageSize(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
        const offset = (page - 1) * pageSize;
        const rawQuery = (url.searchParams.get("q") ?? "").trim();
        const inbox = (url.searchParams.get("inbox") ?? "inbox").toLowerCase();
        const categoryFilter = (url.searchParams.get("category") ?? "all").toLowerCase();
        const tokens = parseSearchTokens(rawQuery);

        const includeDeleted =
          inbox === "trash"
          || tokens.inMailbox.includes("trash")
          || tokens.inMailbox.includes("anywhere");
        const includeArchived =
          inbox === "archive"
          || tokens.inMailbox.includes("archive")
          || tokens.inMailbox.includes("anywhere");
        const where = resolveWhereClause({
          tokens,
          categoryFilter,
          includeDeleted,
          includeArchived,
        });

        if (inbox === "starred") {
          where.clauses.push("COALESCE(ms.is_starred, 0) = 1");
        } else if (inbox === "important") {
          where.clauses.push("COALESCE(ms.is_important, 0) = 1");
        } else if (inbox === "unread") {
          where.clauses.push("COALESCE(ms.is_read, 0) = 0");
        } else if (inbox === "trash") {
          where.clauses.push("COALESCE(ms.is_deleted, 0) = 1");
        } else if (inbox === "archive") {
          where.clauses.push("COALESCE(ms.is_archived, 0) = 1");
          where.clauses.push("COALESCE(ms.is_deleted, 0) = 0");
        } else if (inbox === "snoozed") {
          where.clauses.push("ms.snoozed_until IS NOT NULL");
          where.clauses.push("ms.snoozed_until > CURRENT_TIMESTAMP");
          where.clauses.push("COALESCE(ms.is_deleted, 0) = 0");
        }

        const whereClause = where.clauses.length > 0 ? `WHERE ${where.clauses.join(" AND ")}` : "";

        const totalResult = await env.DB.prepare(
          `
            SELECT COUNT(*) AS total
            FROM raw_mails r
            LEFT JOIN code_mails c ON c.message_id = r.message_id
            LEFT JOIN mail_states ms ON ms.raw_id = r.id
            ${whereClause}
          `
        )
          .bind(...where.bindings)
          .first<{ total: number }>();

        const threadResult = await env.DB.prepare(
          `
            SELECT
              r.id AS rawId,
              r.message_id AS messageId,
              r.from_addr AS fromAddr,
              r.to_addr AS toAddr,
              r.subject AS subject,
              r.raw AS raw,
              r.created_at AS createdAt,
              c.from_org AS fromOrg,
              c.topic AS topic,
              c.code AS code,
              ms.is_read AS isRead,
              ms.is_starred AS isStarred,
              ms.is_archived AS isArchived,
              ms.is_deleted AS isDeleted,
              ms.is_important AS isImportant,
              ms.is_muted AS isMuted,
              ms.category AS category,
              ms.labels_json AS labelsJson,
              ms.snoozed_until AS snoozedUntil
            FROM raw_mails r
            LEFT JOIN code_mails c ON c.message_id = r.message_id
            LEFT JOIN mail_states ms ON ms.raw_id = r.id
            ${whereClause}
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
          `
        )
          .bind(...where.bindings, pageSize, offset)
          .all<ThreadQueryResultRow>();

        const rows = threadResult.results ?? [];
        await ensureMailStateRows(env.DB, rows.map((row) => row.rawId));

        const items = [];
        for (const row of rows) {
          const category = computeCategory(row);
          if (!row.category) {
            await env.DB.prepare(
              `
                UPDATE mail_states
                SET category = ?, updated_at = CURRENT_TIMESTAMP
                WHERE raw_id = ?
              `
            )
              .bind(category, row.rawId)
              .run();
          }

          items.push({
            id: row.rawId,
            threadId: `thread-${row.rawId}`,
            messageId: row.messageId,
            fromAddr: row.fromAddr,
            fromOrg: row.fromOrg,
            toAddr: row.toAddr,
            subject: row.subject,
            topic: row.topic,
            code: row.code,
            snippet: buildThreadSnippet(row),
            createdAt: row.createdAt,
            isRead: Number(row.isRead ?? 0) === 1,
            isStarred: Number(row.isStarred ?? 0) === 1,
            isArchived: Number(row.isArchived ?? 0) === 1,
            isDeleted: Number(row.isDeleted ?? 0) === 1,
            isImportant: Number(row.isImportant ?? 0) === 1,
            isMuted: Number(row.isMuted ?? 0) === 1,
            category,
            labels: parseLabels(row.labelsJson),
            hasCode: Boolean(row.code),
            hasHtml: Boolean(extractMailBodies(String(row.raw ?? "")).htmlBody),
            snoozedUntil: row.snoozedUntil,
          });
        }

        return jsonResponse({
          page,
          pageSize,
          total: Number(totalResult?.total ?? 0),
          items,
        });
      }

      const threadMatch = url.pathname.match(/^\/api\/v2\/threads\/(\d+)$/);
      if (threadMatch && request.method === "GET") {
        const rawId = Number.parseInt(threadMatch[1], 10);
        if (!Number.isFinite(rawId) || rawId < 1) {
          return jsonResponse({ error: "Invalid thread id" }, 400);
        }

        const row = await env.DB.prepare(
          `
            SELECT
              r.id AS rawId,
              r.message_id AS messageId,
              r.from_addr AS fromAddr,
              r.to_addr AS toAddr,
              r.subject AS subject,
              r.raw AS raw,
              r.created_at AS createdAt,
              c.from_org AS fromOrg,
              c.topic AS topic,
              c.code AS code,
              ms.is_read AS isRead,
              ms.is_starred AS isStarred,
              ms.is_archived AS isArchived,
              ms.is_deleted AS isDeleted,
              ms.is_important AS isImportant,
              ms.is_muted AS isMuted,
              ms.category AS category,
              ms.labels_json AS labelsJson,
              ms.snoozed_until AS snoozedUntil
            FROM raw_mails r
            LEFT JOIN code_mails c ON c.message_id = r.message_id
            LEFT JOIN mail_states ms ON ms.raw_id = r.id
            WHERE r.id = ?
            LIMIT 1
          `
        )
          .bind(rawId)
          .first<ThreadQueryResultRow>();

        if (!row) {
          return jsonResponse({ error: "Thread not found" }, 404);
        }

        await ensureMailStateRows(env.DB, [rawId]);
        const category = computeCategory(row);
        if (!row.category) {
          await env.DB.prepare(
            `
              UPDATE mail_states
              SET category = ?, updated_at = CURRENT_TIMESTAMP
              WHERE raw_id = ?
            `
          )
            .bind(category, rawId)
            .run();
        }

        const { textBody, htmlBody } = extractMailBodies(String(row.raw ?? ""));
        return jsonResponse({
          id: row.rawId,
          threadId: `thread-${row.rawId}`,
          messageId: row.messageId,
          fromAddr: row.fromAddr,
          fromOrg: row.fromOrg,
          toAddr: row.toAddr,
          subject: row.subject,
          topic: row.topic,
          code: row.code,
          createdAt: row.createdAt,
          raw: row.raw,
          textBody,
          htmlBody,
          category,
          labels: parseLabels(row.labelsJson),
          isRead: Number(row.isRead ?? 0) === 1,
          isStarred: Number(row.isStarred ?? 0) === 1,
          isArchived: Number(row.isArchived ?? 0) === 1,
          isDeleted: Number(row.isDeleted ?? 0) === 1,
          isImportant: Number(row.isImportant ?? 0) === 1,
          isMuted: Number(row.isMuted ?? 0) === 1,
          snoozedUntil: row.snoozedUntil,
        });
      }

      if (url.pathname === "/api/v2/threads/actions" && request.method === "POST") {
        const payload = await parseJsonBody<{
          action: ThreadAction;
          ids: number[];
          until?: string;
          label?: string;
        }>(request);

        if (!payload || typeof payload !== "object") {
          return jsonResponse({ error: "Invalid payload" }, 400);
        }

        const allowedActions: ThreadAction[] = [
          "read",
          "unread",
          "star",
          "unstar",
          "archive",
          "unarchive",
          "delete",
          "restore",
          "important",
          "not-important",
          "snooze",
          "label-add",
          "label-remove",
        ];

        if (!allowedActions.includes(payload.action)) {
          return jsonResponse({ error: "Invalid action" }, 400);
        }

        const ids = Array.isArray(payload.ids)
          ? payload.ids
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
            .slice(0, 200)
          : [];
        if (ids.length === 0) {
          return jsonResponse({ error: "No valid ids provided" }, 400);
        }

        await ensureMailStateRows(env.DB, ids);
        const placeholders = ids.map(() => "?").join(", ");

        if (payload.action === "read" || payload.action === "unread") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_read = ?, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(payload.action === "read" ? 1 : 0, ...ids)
            .run();
        } else if (payload.action === "star" || payload.action === "unstar") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_starred = ?, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(payload.action === "star" ? 1 : 0, ...ids)
            .run();
        } else if (payload.action === "archive" || payload.action === "unarchive") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(payload.action === "archive" ? 1 : 0, ...ids)
            .run();
        } else if (payload.action === "delete") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_deleted = 1, is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(...ids)
            .run();
        } else if (payload.action === "restore") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_deleted = 0, is_archived = 0, snoozed_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(...ids)
            .run();
        } else if (payload.action === "important" || payload.action === "not-important") {
          await env.DB.prepare(
            `UPDATE mail_states SET is_important = ?, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(payload.action === "important" ? 1 : 0, ...ids)
            .run();
        } else if (payload.action === "snooze") {
          const untilDate = payload.until ? new Date(payload.until) : null;
          if (!untilDate || Number.isNaN(untilDate.getTime())) {
            return jsonResponse({ error: "Invalid snooze timestamp" }, 400);
          }
          await env.DB.prepare(
            `UPDATE mail_states SET snoozed_until = ?, is_archived = 0, is_deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE raw_id IN (${placeholders})`
          )
            .bind(untilDate.toISOString(), ...ids)
            .run();
        } else if (payload.action === "label-add" || payload.action === "label-remove") {
          const normalizedLabel = String(payload.label ?? "").trim().toLowerCase().slice(0, 64);
          if (!normalizedLabel) {
            return jsonResponse({ error: "Label is required for label actions" }, 400);
          }

          const currentRows = await env.DB.prepare(
            `SELECT raw_id, labels_json FROM mail_states WHERE raw_id IN (${placeholders})`
          )
            .bind(...ids)
            .all<{ raw_id: number; labels_json: string | null }>();

          for (const row of currentRows.results ?? []) {
            const labels = parseLabels(row.labels_json);
            const next =
              payload.action === "label-add"
                ? Array.from(new Set([...labels, normalizedLabel]))
                : labels.filter((label) => label !== normalizedLabel);
            await env.DB.prepare(
              `
                UPDATE mail_states
                SET labels_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE raw_id = ?
              `
            )
              .bind(stringifyLabels(next), row.raw_id)
              .run();
          }
        }

        return jsonResponse({ success: true, updated: ids.length });
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    if (url.pathname === "/api/mails" && request.method === "GET") {
      const page = clampPage(url.searchParams.get("page"), 1);
      const pageSize = clampPageSize(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
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
    await ensureGmailUiTables(env.DB);

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

    const promotionalEmail = isPromotionalEmail(message.headers, rawEmail);

    // Persist raw mail payload for auditing // 将原始邮件持久化以便审计
    const insertRawResult = await env.DB.prepare(
      "INSERT INTO raw_mails (from_addr, to_addr, subject, raw, message_id) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(message.from, message.to, rawSubject, rawEmail, messageId)
      .run();
    const success = insertRawResult.success;
    const rawRowId = Number((insertRawResult.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);

    if (!success) {
      message.setReject("Failed to save message payload");
      console.log(`Failed to save raw mail payload for messageId=${messageId ?? "unknown"}`);
    } else if (rawRowId > 0) {
      const initialCategory = promotionalEmail
        ? "promotions"
        : inferCategoryFromFields(message.from, rawSubject);
      await env.DB.prepare(
        `
          INSERT OR IGNORE INTO mail_states (raw_id, category, is_read, is_starred, is_archived, is_deleted, is_important, is_muted, labels_json)
          VALUES (?, ?, 0, 0, 0, 0, 0, 0, '[]')
        `
      )
        .bind(rawRowId, initialCategory)
        .run();
    }

    // Skip promotional/bulk emails before hitting the LLM
    if (promotionalEmail) {
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
