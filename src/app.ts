import { Hono } from "hono";
import type { AppEnv } from "./types";
import { apiKeyAuth, requireAdmin, sessionAuth } from "./middleware/auth";
import authRoutes from "./routes/auth";
import mailRoutes from "./routes/mails";
import adminRoutes from "./routes/admin";
import keyRoutes from "./routes/keys";
import mcpApp from "./mcp/server";

const app = new Hono<AppEnv>();

// ---------- 认证边界 ----------
// /api/auth/* 开放 (login/setup 本身不能要求登录)
// /api/* 其余全部要求 session
// /api/admin/* 额外要求 admin
// /mcp 走 API key
app.route("/api/auth", authRoutes);

app.use("/api/mails/*", sessionAuth);
app.use("/api/mails", sessionAuth);
app.route("/api/mails", mailRoutes);

app.use("/api/keys/*", sessionAuth);
app.use("/api/keys", sessionAuth);
app.route("/api/keys", keyRoutes);

app.use("/api/admin/*", sessionAuth, requireAdmin);
app.route("/api/admin", adminRoutes);

app.use("/mcp", apiKeyAuth);
app.route("/mcp", mcpApp);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ---------- 静态资源 + SPA fallback ----------
// 前端登录页需要公开可达, API 已在上面各自设卡, 所以资源本身不再加 Basic Auth。
app.get("*", async (c) => {
  if (!c.env.ASSETS) {
    return c.text("Assets binding not configured", 500);
  }

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status !== 404) {
    return assetResponse;
  }

  // SPA history fallback
  const indexRequest = new Request(new URL("/index.html", c.req.url).toString(), c.req.raw);
  const indexResponse = await c.env.ASSETS.fetch(indexRequest);
  if (indexResponse.status !== 404) {
    return indexResponse;
  }

  return c.text("Not found", 404);
});

export default app;
