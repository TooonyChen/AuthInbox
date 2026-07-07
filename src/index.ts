/*
 * index.ts — AuthInbox v2
 * WorkerEntrypoint 外壳: fetch 交给 Hono, email 交给 handler, rpcEmail 保留。
 * Hono 只接管 HTTP; Email Workers 的 email() 和跨 Worker RPC 需要这个类。
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { handleEmail } from "./email/handler";
import { RPCEmailMessage } from "./email/rpcEmail";
import type { Env } from "./types";

export default class extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  async email(message: ForwardableEmailMessage): Promise<void> {
    return handleEmail(message, this.env);
  }

  // 保留给其他 Worker 的 RPC 入口, 行为与旧版一致
  async rpcEmail(requestBody: string): Promise<void> {
    const bodyObject = JSON.parse(requestBody);
    const headers = new Headers(bodyObject.headers);
    const rpcEmailMessage = new RPCEmailMessage(
      bodyObject.from,
      bodyObject.to,
      bodyObject.rawEmail,
      headers,
    );
    await this.email(rpcEmailMessage);
  }
}
