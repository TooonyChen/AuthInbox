import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv, OAuthProps } from "../types";
import { findUserByApiKey, findUserById, verifySession } from "../services/auth";

export const SESSION_COOKIE = "authinbox_session";

// Web 端: 从 HttpOnly cookie 读 session JWT
export const sessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const user = await verifySession(token, c.env.JWT_SECRET);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user")?.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

// MCP over OAuth (claude.ai 远程连接器): OAuthProvider 已校验过 access token,
// 解密后的 props 挂在 executionCtx 上。这里只做 userId → 用户实体的回表。
export const oauthPropsAuth = createMiddleware<AppEnv>(async (c, next) => {
  const props = (c.executionCtx as ExecutionContext & { props?: OAuthProps }).props;
  const userId = Number(props?.userId);
  const user = Number.isInteger(userId) ? await findUserById(c.env.DB, userId) : null;
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  c.set("user", user);
  await next();
});

// MCP / 程序化访问: Authorization: Bearer aik_xxx
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return c.json({ error: "Missing bearer token" }, 401);
  }
  const user = await findUserByApiKey(c.env.DB, header.slice("Bearer ".length).trim());
  if (!user) return c.json({ error: "Invalid API key" }, 401);

  c.set("user", user);
  await next();
});
