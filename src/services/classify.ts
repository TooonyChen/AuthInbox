import type { Env, ProviderConfig, MailCategory } from "../types";
import { MAIL_CATEGORIES } from "../types";

/*
 * callProvider / extractJsonFromText 从旧 index.ts 原样迁移,
 * 变化只有一处: prompt 增加 category 字段, extractMailInfo 返回强类型结果。
 */

export interface ExtractedMail {
  codeExist: 0 | 1;
  title?: string;
  code?: string;
  topic?: string;
  category?: MailCategory;
}

function extractJsonFromText(rawText: string): Record<string, unknown> | null {
  let candidate = rawText.trim();
  const jsonMatch = candidate.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    candidate = jsonMatch[1].trim();
  }
  try {
    return JSON.parse(candidate);
  } catch (parseError) {
    console.error("JSON parsing error:", parseError);
    return null;
  }
}

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

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

  if (config.format === "openai") {
    const content = (payload as any)?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const part = content.find((p: any) => p?.type === "text" && typeof p.text === "string");
      return part?.text ?? null;
    }
    return null;
  }

  if (config.format === "responses") {
    const text =
      (payload as any)?.output?.[0]?.content?.[0]?.text ?? (payload as any)?.output?.[0]?.text;
    return typeof text === "string" ? text : null;
  }

  const text = (payload as any)?.content?.[0]?.text;
  return typeof text === "string" ? text : null;
}

function buildPrompt(rawEmail: string): string {
  return `
Email content: ${rawEmail}

Please read the email and extract the following information:
1. Code/Link/Password from the email (if available).
2. Organization name (title) from which the email is sent.
3. A brief summary of the email's topic (e.g., 'line register verification').
4. A category classifying the email's purpose.

"category" MUST be exactly one of:
- "login_code": a one-time code or link used to LOG IN to an existing account (2FA, OTP, magic link)
- "registration": verifying a NEW account signup (confirm email, activation link)
- "password_reset": resetting or changing a password
- "account_security": account security notices (email/phone change confirmation, new device login alert, account recovery)
- "payment": billing, receipts, payment confirmations
- "other": anything else that still contains a code or link

Please provide the following information in JSON format:
{
  "title": "The organization or company that sent the email (e.g., 'Netflix')",
  "code": "The extracted verification code, link, or password (e.g., '123456' or 'https://example.com/verify?code=123456')",
  "topic": "A brief summary of the email's topic (e.g., 'line register verification')",
  "category": "login_code",
  "codeExist": 1
}

If both a code and a link are present, include both in the 'code' field like this:
"code": "code, link"

If there is no code, clickable link, or this is an advertisement email, return:
{
  "codeExist": 0
}
`;
}

function coerceCategory(value: unknown): MailCategory {
  if (typeof value === "string" && (MAIL_CATEGORIES as readonly string[]).includes(value)) {
    return value as MailCategory;
  }
  // 分类器输出不合法时落到 other, 不落到敏感类, 也不落到 login_code
  return "other";
}

export async function extractMailInfo(env: Env, rawEmail: string): Promise<ExtractedMail | null> {
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

  const prompt = buildPrompt(rawEmail);
  const maxRetries = 3;
  let parsed: Record<string, unknown> | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const text = await callProvider(primary, prompt);
    if (text) {
      parsed = extractJsonFromText(text);
      if (parsed) break;
    }
  }

  if (!parsed && fallback) {
    const text = await callProvider(fallback, prompt);
    if (text) parsed = extractJsonFromText(text);
  }

  if (!parsed) return null;

  if (parsed.codeExist !== 1) return { codeExist: 0 };

  return {
    codeExist: 1,
    title: typeof parsed.title === "string" ? parsed.title : "Unknown Organization",
    code: typeof parsed.code === "string" ? parsed.code : "No Code Found",
    topic: typeof parsed.topic === "string" ? parsed.topic : "No Topic Found",
    category: coerceCategory(parsed.category),
  };
}
