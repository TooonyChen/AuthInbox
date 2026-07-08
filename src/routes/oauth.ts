import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { AppEnv, AuthedUser } from "../types";
import { verifySession } from "../services/auth";
import { SESSION_COOKIE } from "../middleware/auth";

/*
 * OAuth 授权同意页 (claude.ai 远程连接器接入用)。
 * /oauth/token、/oauth/register、/.well-known/* 都由 OAuthProvider (src/index.ts)
 * 自动实现, 这里只需要实现 authorizeEndpoint:
 *   GET  /oauth/authorize — 没登录跳 SPA 登录 (带 returnTo); 已登录渲染同意页
 *   POST /oauth/authorize — 批准/拒绝。批准则 completeAuthorization 发 code 跳回客户端
 *
 * CSRF: session cookie 是 SameSite=Strict, 跨站表单 POST 带不上 cookie, 天然挡掉。
 */

const oauthRoutes = new Hono<AppEnv>();

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function sessionUser(c: Context<AppEnv>): Promise<AuthedUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? verifySession(token, c.env.JWT_SECRET) : null;
}

// redirect_uri 必须是客户端注册过的, 防开放跳转
function redirectUriAllowed(client: ClientInfo, oauthReq: AuthRequest): boolean {
  return client.redirectUris.includes(oauthReq.redirectUri);
}

function consentPage(user: AuthedUser, client: ClientInfo, oauthReq: AuthRequest): string {
  const clientName = escapeHtml(client.clientName ?? client.clientId);
  const redirectHost = escapeHtml(new URL(oauthReq.redirectUri).host);
  const encodedReq = btoa(JSON.stringify(oauthReq));
  const scopes = oauthReq.scope.length
    ? `<div class="row"><span class="label">Scopes</span><span>${escapeHtml(oauthReq.scope.join(", "))}</span></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authorize · Auth Inbox</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: hsl(0 0% 4%); color: hsl(0 0% 92%);
    font-family: Manrope, ui-sans-serif, system-ui, sans-serif;
    background-image: radial-gradient(900px 400px at 50% -10%, rgba(95, 224, 192, 0.1), transparent);
  }
  .card {
    width: 100%; max-width: 24rem; margin: 1rem; padding: 2rem;
    background: hsl(0 0% 8%); border: 1px solid hsl(0 0% 20%); border-radius: 0.8rem;
  }
  .eyebrow {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.16em; color: hsl(0 0% 68%);
  }
  .eyebrow svg { color: hsl(164 67% 63%); }
  h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
  .sub { margin: 0 0 1.5rem; font-size: 0.875rem; color: hsl(0 0% 68%); }
  .rows { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1.5rem; font-size: 0.875rem; }
  .row { display: flex; justify-content: space-between; gap: 1rem; }
  .label { color: hsl(0 0% 68%); }
  .actions { display: flex; gap: 0.75rem; }
  button {
    flex: 1; padding: 0.55rem 1rem; border-radius: 0.6rem; font: inherit; font-weight: 600; cursor: pointer;
  }
  .approve { background: hsl(164 67% 63%); border: 1px solid hsl(164 67% 63%); color: hsl(0 0% 5%); }
  .approve:hover { filter: brightness(1.1); }
  .deny { background: transparent; border: 1px solid hsl(0 0% 20%); color: hsl(0 0% 92%); }
  .deny:hover { background: hsl(0 0% 13%); }
</style>
</head>
<body>
<main class="card">
  <div class="eyebrow">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
    Private Mail Console
  </div>
  <h1>Authorize access</h1>
  <p class="sub"><strong>${clientName}</strong> wants to read verification codes from Auth Inbox as <strong>${escapeHtml(user.username)}</strong>.</p>
  <div class="rows">
    <div class="row"><span class="label">Redirects to</span><span>${redirectHost}</span></div>
    ${scopes}
    <div class="row"><span class="label">Access</span><span>Same as your account permissions</span></div>
  </div>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="req" value="${encodedReq}">
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

oauthRoutes.get("/authorize", async (c) => {
  const provider = c.env.OAUTH_PROVIDER;
  if (!provider) {
    // 没绑定 OAUTH_KV 时请求不经过 OAuthProvider, 整个 OAuth 功能视为未启用
    return c.text("OAuth is not enabled on this deployment (no OAUTH_KV binding)", 404);
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = await provider.parseAuthRequest(c.req.raw);
  } catch {
    return c.text("Invalid authorization request", 400);
  }

  const client = await provider.lookupClient(oauthReq.clientId);
  if (!client || !redirectUriAllowed(client, oauthReq)) {
    return c.text("Unknown client or redirect URI", 400);
  }

  const user = await sessionUser(c);
  if (!user) {
    // claude.ai 过来的跳转是跨站导航, Strict cookie 不随行, 先经 SPA 登录再同站跳回来
    const returnTo = encodeURIComponent(`/oauth/authorize?${new URL(c.req.url).searchParams.toString()}`);
    return c.redirect(`/?returnTo=${returnTo}`, 302);
  }

  return c.html(consentPage(user, client, oauthReq));
});

oauthRoutes.post("/authorize", async (c) => {
  const provider = c.env.OAUTH_PROVIDER;
  if (!provider) {
    return c.text("OAuth is not enabled on this deployment (no OAUTH_KV binding)", 404);
  }

  const user = await sessionUser(c);
  if (!user) return c.text("Unauthorized", 401);

  const form = await c.req.formData().catch(() => null);
  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(String(form?.get("req") ?? "")));
  } catch {
    return c.text("Invalid authorization request", 400);
  }

  const client = await provider.lookupClient(oauthReq.clientId);
  if (!client || !redirectUriAllowed(client, oauthReq)) {
    return c.text("Unknown client or redirect URI", 400);
  }

  if (form?.get("decision") !== "approve") {
    const denied = new URL(oauthReq.redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (oauthReq.state) denied.searchParams.set("state", oauthReq.state);
    return c.redirect(denied.toString(), 302);
  }

  const { redirectTo } = await provider.completeAuthorization({
    request: oauthReq,
    userId: String(user.id),
    metadata: { username: user.username, grantedAt: new Date().toISOString() },
    scope: oauthReq.scope,
    props: { userId: user.id },
  });

  return c.redirect(redirectTo, 302);
});

export default oauthRoutes;
