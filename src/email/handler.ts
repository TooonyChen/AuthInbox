import type { Env } from "../types";
import { extractMailInfo } from "../services/classify";
import { isPromotionalEmail } from "../services/mime";
import { RPCEmailMessage } from "./rpcEmail";

/*
 * 架构边界 (沿袭旧版, 不可违反):
 * 1. isPromotionalEmail() 必须先于任何 LLM 调用
 * 2. 每封进件必写 raw_mails, 只有 AI 提取结果写 code_mails
 */

async function pushBark(env: Env, title: string, code: string): Promise<void> {
  const barkTokens = env.barkTokens
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((token) => token.trim());

  const encodedTitle = encodeURIComponent(title);
  const encodedCode = encodeURIComponent(code);

  for (const token of barkTokens) {
    const barkRequestUrl = `${env.barkUrl}/${token}/${encodedTitle}/${encodedCode}`;
    try {
      const res = await fetch(barkRequestUrl, { method: "GET" });
      if (!res.ok) {
        console.error(`Bark push failed for token ${token}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error(`Bark push error for token ${token}:`, err);
    }
  }
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const useBark = env.UseBark.toLowerCase() === "true";

  const rawEmail =
    message instanceof RPCEmailMessage
      ? String((message as RPCEmailMessage).rawEmail)
      : await new Response(message.raw).text();
  const messageId = message.headers.get("Message-ID");
  const rawSubject = message.headers.get("Subject");

  // 边界 2: 进件必写 raw_mails
  const { success } = await env.DB.prepare(
    "INSERT INTO raw_mails (from_addr, to_addr, subject, raw, message_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(message.from, message.to, rawSubject, rawEmail, messageId)
    .run();

  if (!success) {
    message.setReject(`Failed to save message from ${message.from} to ${message.to}`);
    console.log(`Failed to save message from ${message.from} to ${message.to}`);
    return;
  }

  // 边界 1: 推广邮件在 LLM 之前拦截
  if (isPromotionalEmail(message.headers, rawEmail)) {
    console.log(`Skipping promotional email from ${message.from}: ${rawSubject}`);
    return;
  }

  try {
    const extracted = await extractMailInfo(env, rawEmail);

    if (!extracted) {
      console.error("Failed to extract data from AI response after retries.");
      return;
    }

    if (extracted.codeExist !== 1) {
      console.log("No code found in this email, skipping.");
      return;
    }

    const { title, code, topic, category } = extracted;

    const { success: codeMailSuccess } = await env.DB.prepare(
      `INSERT INTO code_mails (from_addr, from_org, to_addr, code, topic, category, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(message.from, title, message.to, code, topic, category, messageId)
      .run();

    if (!codeMailSuccess) {
      message.setReject(
        `Failed to save extracted code for message from ${message.from} to ${message.to}`,
      );
      return;
    }

    if (useBark) {
      await pushBark(env, title!, code!);
    }
  } catch (e) {
    console.error("Error calling AI or saving to database:", e);
  }
}
