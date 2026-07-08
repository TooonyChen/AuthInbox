/*
 * index.ts — AuthInbox v2
 * WorkerEntrypoint 外壳: fetch 交给 OAuthProvider → Hono, email 交给 handler, rpcEmail 保留。
 * Hono 只接管 HTTP; Email Workers 的 email() 和跨 Worker RPC 需要这个类。
 *
 * OAuthProvider (claude.ai 远程连接器要求 OAuth), 可选功能, 绑定 OAUTH_KV 才启用:
 *   - /oauth/token, /oauth/register (动态客户端注册), /.well-known/* 由库实现, 存 OAUTH_KV
 *   - /oauth/authorize 转给 defaultHandler (Hono, routes/oauth.ts 渲染同意页)
 *   - /mcp 带合法 OAuth token → mcpOAuthHandler; 无效 token → 401 + WWW-Authenticate
 *     (这个 401 正是触发客户端走 OAuth 流程的信号)
 *   - 例外: Bearer aik_ 开头的 /mcp 请求是老的 API key 路径, 在进 OAuthProvider
 *     之前分流回 Hono (apiKeyAuth), 两种认证长期共存
 * 未绑定 OAUTH_KV 时整个 provider 被绕过, 行为与纯 API key 版本完全一致。
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import app from "./app";
import { mcpOAuthHandler } from "./mcp/server";
import { handleEmail } from "./email/handler";
import { RPCEmailMessage } from "./email/rpcEmail";
import type { Env } from "./types";

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpOAuthHandler,
  defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
});

export default class extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    if (!this.env.OAUTH_KV) {
      return app.fetch(request, this.env, this.ctx);
    }
    const authz = request.headers.get("Authorization") ?? "";
    if (new URL(request.url).pathname === "/mcp" && authz.startsWith("Bearer aik_")) {
      return app.fetch(request, this.env, this.ctx);
    }
    return oauthProvider.fetch(request, this.env, this.ctx);
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
