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

interface Env {
  // If you set another name in wrangler.toml as the value for 'binding',
  // replace "DB" with the variable name you defined.
  DB: D1Database;
  FrontEndAdminID: string;
  FrontEndAdminPassword: string;
  barkTokens: string;
  barkUrl: string;
  GoogleAPIKey: string;
  UseBark: string;
  GeminiModel?: string;
  OpenAIAPIKey?: string;
  OpenAIBaseUrl?: string;
  OpenAIModel?: string;
}

interface ModelResponse {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

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

// Read structured content from Gemini response // 读取 Gemini 响应中的结构化文本
function extractGeminiText(payload: unknown): string | null {
  const candidate = (payload as any)?.candidates?.[0]?.content?.parts?.[0];
  if (!candidate || typeof candidate.text !== "string") {
    console.error("Gemini response is missing expected data structure");
    return null;
  }
  return candidate.text;
}

// Read structured content from OpenAI response // 读取 OpenAI 响应中的结构化文本
function extractOpenAIText(payload: unknown): string | null {
  const message = (payload as any)?.choices?.[0]?.message;
  if (!message) {
    console.error("OpenAI response is missing choices");
    return null;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textPart = content.find((part: any) => part?.type === "text" && typeof part.text === "string");
    if (textPart) {
      return textPart.text;
    }
  }

  if (typeof message?.content?.[0]?.text === "string") {
    return message.content[0].text;
  }

  console.error("OpenAI response is missing text content");
  return null;
}

// Remove trailing slashes to avoid double separators // 移除结尾斜杠防止重复拼接
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env: Env = this.env;
    const FrontEndAdminID = env.FrontEndAdminID;
    const FrontEndAdminPassword = env.FrontEndAdminPassword;

    // Basic-auth gate for the admin console // 使用 Basic Auth 保护管理界面
    const authHeader = request.headers.get("Authorization");

    if (!authHeader) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Basic realm=\"User Visible Realm\"",
        },
      });
    }

    if (!authHeader.startsWith("Basic ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Basic realm=\"User Visible Realm\"",
        },
      });
    }

    const base64Credentials = authHeader.substring("Basic ".length);
    const decodedCredentials = atob(base64Credentials);
    const [username, password] = decodedCredentials.split(":");

    if (username !== FrontEndAdminID || password !== FrontEndAdminPassword) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Basic realm=\"User Visible Realm\"",
        },
      });
    }

    try {
      const { results } = await env.DB.prepare(
        "SELECT from_org, to_addr, topic, code, created_at FROM code_mails ORDER BY created_at DESC"
      ).all();

      let dataHtml = "";
      for (const row of results) {
        const codeLinkParts = row.code.split(",");
        let codeLinkContent;

        if (codeLinkParts.length > 1) {
          const [code, link] = codeLinkParts;
          codeLinkContent = `${code}<br><a href="${link}" target="_blank">${row.topic}</a>`;
        } else if (row.code.startsWith("http")) {
          codeLinkContent = `<a href="${row.code}" target="_blank">${row.topic}</a>`;
        } else {
          codeLinkContent = row.code;
        }

        dataHtml += `<tr>
                    <td>${row.from_org}</td>
                    <td>${row.to_addr}</td>
                    <td>${row.topic}</td>
                    <td>${codeLinkContent}</td>
                    <td>${row.created_at}</td>
                </tr>`;
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

      return new Response(responseHtml, {
        headers: {
          "Content-Type": "text/html",
        },
      });
    } catch (error) {
      console.error("Error querying database:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Call Gemini for primary extraction // 调用 Gemini 执行主解析
  private async callGemini(prompt: string, apiKey: string, model: string): Promise<ModelResponse> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    };

    try {
      const response = await fetch(endpoint, init);
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        console.error("Gemini JSON parse error:", parseError);
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        payload,
      };
    } catch (error) {
      console.error("Gemini request threw:", error);
      return {
        ok: false,
        status: 0,
        statusText: "FETCH_ERROR",
        payload: null,
      };
    }
  }

  // Call OpenAI as the fallback extractor // 调用 OpenAI 作为兜底解析
  private async callOpenAI(
    prompt: string,
    baseUrl: string,
    apiKey: string,
    model: string
  ): Promise<ModelResponse> {
    const endpoint = `${normaliseBaseUrl(baseUrl)}/v1/chat/completions`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You return only valid JSON that matches the requested schema.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    };

    try {
      const response = await fetch(endpoint, init);
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        console.error("OpenAI JSON parse error:", parseError);
      }
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        payload,
      };
    } catch (error) {
      console.error("OpenAI request threw:", error);
      return {
        ok: false,
        status: 0,
        statusText: "FETCH_ERROR",
        payload: null,
      };
    }
  }

  // Primary email handler // 主要邮件处理入口
  async email(message: ForwardableEmailMessage): Promise<void> {
    const env: Env = this.env;
    const useBark = env.UseBark.toLowerCase() === "true";
    const googleApiKey = env.GoogleAPIKey;
    const geminiModel = env.GeminiModel || DEFAULT_GEMINI_MODEL;
    const openAIKey = env.OpenAIAPIKey;
    const openAIBaseUrl = env.OpenAIBaseUrl || DEFAULT_OPENAI_BASE_URL;
    const openAIModel = env.OpenAIModel || DEFAULT_OPENAI_MODEL;

    // Pull raw email content // 获取原始邮件内容
    const rawEmail =
      message instanceof RPCEmailMessage
        ? (message as RPCEmailMessage).rawEmail
        : await new Response(message.raw).text();
    const messageId = message.headers.get("Message-ID");

    // Persist raw mail payload for auditing // 将原始邮件持久化以便审计
    const { success } = await env.DB.prepare(
      "INSERT INTO raw_mails (from_addr, to_addr, raw, message_id) VALUES (?, ?, ?, ?)"
    )
      .bind(message.from, message.to, rawEmail, messageId)
      .run();

    if (!success) {
      message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
      console.log(`Failed to save message from ${message.from} to ${message.to}`);
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
      let retryCount = 0;
      let extractedData: Record<string, unknown> | null = null;
      let geminiStatusError = false;

      // First attempt Gemini with simple retries // 先使用 Gemini 并进行简单重试
      while (retryCount < maxRetries && !extractedData && !geminiStatusError) {
        const geminiResult = await this.callGemini(aiPrompt, googleApiKey, geminiModel);
        console.log(`Gemini response attempt ${retryCount + 1}:`, geminiResult.payload);

        if (!geminiResult.ok) {
          geminiStatusError = true;
          console.error(
            `Gemini request failed with status ${geminiResult.status} ${geminiResult.statusText}`
          );
          break;
        }

        const extractedText = extractGeminiText(geminiResult.payload);
        if (extractedText) {
          console.log(`Extracted Text before parsing: "${extractedText}"`);
          const parsed = extractJsonFromText(extractedText);
          if (parsed) {
            extractedData = parsed;
            console.log("Parsed Extracted Data:", extractedData);
            break;
          }
        }

        retryCount += 1;
        if (retryCount < maxRetries) {
          console.log("Retrying AI request...");
        } else {
          console.error("Max retries reached. Unable to get valid AI response.");
        }
      }

      if (!extractedData && geminiStatusError && openAIKey) {
        // Gemini failed with non-200, switch to OpenAI fallback // 当 Gemini 返回非 200 时切换到 OpenAI 兜底
        const openAIResult = await this.callOpenAI(aiPrompt, openAIBaseUrl, openAIKey, openAIModel);
        console.log("OpenAI fallback response:", openAIResult.payload);
        if (!openAIResult.ok) {
          console.error(
            `OpenAI fallback failed with status ${openAIResult.status} ${openAIResult.statusText}`
          );
        } else {
          const openAIText = extractOpenAIText(openAIResult.payload);
          if (openAIText) {
            console.log(`OpenAI text before parsing: "${openAIText}"`);
            const parsed = extractJsonFromText(openAIText);
            if (parsed) {
              extractedData = parsed;
              console.log("Parsed Extracted Data from OpenAI:", extractedData);
            }
          }
        }
      } else if (!extractedData && geminiStatusError) {
        console.error("Gemini request failed and OpenAI fallback is not configured.");
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
    const bodyObject = JSON.parse(requestBody);
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
