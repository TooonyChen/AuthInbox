# Repository Guidelines

## Project Structure

- `src/index.ts` — `WorkerEntrypoint` shell: `fetch()` → `OAuthProvider` (`@cloudflare/workers-oauth-provider`; implements `/oauth/token`, `/oauth/register`, `/.well-known/*`, stores tokens in `OAUTH_KV`) → Hono app. `Bearer aik_` requests to `/mcp` bypass the provider straight to Hono, and the provider is skipped entirely when the optional `OAUTH_KV` binding is absent (OAuth disabled). `email()` → email handler, `rpcEmail()` RPC method.
- `src/app.ts` — Hono app: route mounting, auth middleware boundaries, SPA fallback via `ASSETS`.
- `src/routes/` — REST API: `auth.ts` (`/api/auth`: setup/login/logout/me), `mails.ts` (`/api/mails`), `admin.ts` (`/api/admin`: users + grants, admin only), `keys.ts` (`/api/keys`: self-service API keys), `oauth.ts` (`/oauth/authorize`: OAuth consent page for claude.ai remote connectors).
- `src/middleware/auth.ts` — `sessionAuth` (JWT cookie `authinbox_session`), `requireAdmin`, `apiKeyAuth` (Bearer `aik_…` keys), `oauthPropsAuth` (OAuth token props → D1 user lookup).
- `src/services/` — `mail.ts` (`visibleMails` — the single permission-filtered query layer), `auth.ts` (PBKDF2 / JWT / API keys via WebCrypto), `classify.ts` (`callProvider` LLM extraction + category), `mime.ts` (MIME decoding, promotional filter).
- `src/email/handler.ts` — incoming email pipeline; `src/email/rpcEmail.ts` — RPC-compatible `ForwardableEmailMessage` wrapper.
- `src/mcp/server.ts` — remote MCP server at `/mcp` (`@hono/mcp` Streamable HTTP): `list_addresses`, `list_codes`, `get_latest_code`, `wait_for_code`.
- `web/` — React 18 + Vite + Tailwind + shadcn/ui frontend. Built to `web/dist`, served via Cloudflare `ASSETS` binding. Pages: Login (doubles as first-admin setup), Inbox, API Keys, Users & Access (admin).
- `migrations/` — D1 schema, applied with `wrangler d1 migrations apply`. Tables: `raw_mails`, `code_mails` (+ `category`), `users`, `api_keys`, `grants`.

## Commands

```bash
# Install
pnpm install                     # root (Worker) deps; pnpm workspace includes web/
# Dev
pnpm run dev                     # wrangler dev — local Worker on :8787
pnpm run dev:web                 # Vite dev server on :5173 (proxies /api → :8787)
# Database
pnpm run db:migrate:local        # apply D1 migrations locally
pnpm run db:migrate:remote       # apply D1 migrations to live D1
# Build & deploy
pnpm run build:web               # vite build → web/dist
pnpm run deploy                  # build:web + db:migrate:remote + wrangler deploy
# Misc
pnpm run test                    # vitest with @cloudflare/vitest-pool-workers
pnpm run cf-typegen              # regenerate Worker type bindings
```

Local setup:
```bash
cp wrangler.toml.example wrangler.toml   # fill in database_id + AI config (+ optional OAUTH_KV id for OAuth)
echo 'JWT_SECRET=any-local-dev-secret' > .dev.vars   # local session signing (gitignored)
pnpm run db:migrate:local
pnpm run build:web
pnpm run dev
```

## Architecture Constraints

- **Promotional filter runs before LLM.** `isPromotionalEmail()` checks `List-Unsubscribe`, `List-ID`, `Precedence: bulk/list`, and known ESP X-headers. If matched, raw email is still saved to `raw_mails` but LLM is skipped.
- **Two DB tables, strict separation.** Every email → `raw_mails`. Only emails with extracted codes/links → `code_mails`. Never skip `raw_mails` insert.
- **`visibleMails()` in `src/services/mail.ts` is the only permission layer.** REST routes and MCP tools must query mails through it — never add a second filter path. Grants are enforced in SQL (GLOB address pattern + category allowlist).
- **Sensitive categories are default-deny.** `password_reset`, `account_security` require `allow_sensitive = 1` on the grant; `legacy` (pre-v2 mails) is always admin-only. Raw email bodies (`raw`/`textBody`/`htmlBody`) are admin-only on every interface.
- **Auth boundaries live in middleware.** `/api/*` behind `sessionAuth` (except `/api/auth` public endpoints), `/api/admin/*` additionally behind `requireAdmin`. `/mcp` accepts two credentials: `aik_` keys behind `apiKeyAuth` (routed in `src/index.ts` before the provider) and OAuth access tokens validated by `OAuthProvider` then resolved by `oauthPropsAuth`. Static assets are intentionally public; data only flows through authed APIs.
- **`ASSETS` is required for the frontend.** The Worker serves the React app from the `ASSETS` binding (name must be `ASSETS`); there is no server-rendered fallback.
- **`web/dist` is gitignored.** Built at deploy time via `pnpm run deploy`. No need to commit build artifacts.
- **Schema changes go through `migrations/`** as new numbered files; never edit applied migrations.

## Auth Model

- Web: username/password → PBKDF2-SHA256 (100k iterations, WebCrypto) → JWT (HS256, 7-day exp) in HttpOnly cookie `authinbox_session`. Signing key is the `JWT_SECRET` Cloudflare secret.
- First admin: `POST /api/auth/setup` works only while the `users` table is empty (the login page automates this).
- MCP / programmatic: `Authorization: Bearer aik_…` API keys; only the SHA-256 hash is stored, plaintext shown once at creation. Keys inherit the owner's role and grants.
- MCP / OAuth (claude.ai remote connectors, **optional feature**): enabled only when the `OAUTH_KV` KV namespace is bound (binding name is mandated by the library; without it `/oauth/*` returns 404 and `/mcp` accepts only `aik_` keys). OAuth 2.1 + PKCE + dynamic client registration via `@cloudflare/workers-oauth-provider`; tokens/grants/clients live in `OAUTH_KV`. The consent page at `/oauth/authorize` reuses the session cookie — unauthenticated visitors are bounced through the SPA login with `returnTo`. Grant props store only `userId`; `oauthPropsAuth` re-fetches the user from D1 on every request, so deleting a user instantly revokes OAuth access.

## AI Provider Configuration

The AI layer uses a single unified function `callProvider(config: ProviderConfig, prompt)` in `src/services/classify.ts`. All provider-specific logic is contained there — do not add new per-provider methods. The extraction prompt also assigns a `category` (`login_code` | `registration` | `password_reset` | `account_security` | `payment` | `other`); invalid output coerces to `other`.

**Env vars (set in `wrangler.toml` `[vars]` or as Cloudflare Secrets):**

| Variable | Required | Description |
|---|---|---|
| `AI_BASE_URL` | ✅ | Provider base URL, no trailing slash |
| `AI_API_KEY` | ✅ | API key (use Secret in production) |
| `AI_API_FORMAT` | ✅ | `openai` \| `responses` \| `anthropic` |
| `AI_MODEL` | ✅ | Model ID |
| `JWT_SECRET` | ✅ (Secret) | Session JWT signing key |
| `AI_FALLBACK_BASE_URL` | optional | Fallback provider base URL |
| `AI_FALLBACK_API_KEY` | optional | Fallback API key |
| `AI_FALLBACK_API_FORMAT` | optional | Fallback format |
| `AI_FALLBACK_MODEL` | optional | Fallback model ID |
| `UseBark` / `barkUrl` / `barkTokens` | optional | Bark iOS push |

Fallback is only active when all four `AI_FALLBACK_*` vars are set. Primary retries 3× before fallback is attempted (1×).

**Format → endpoint mapping:**
- `openai` → `POST /v1/chat/completions` (OpenAI, Gemini OpenAI-compat, DeepSeek, Groq, …)
- `responses` → `POST /v1/responses` (OpenAI Responses API)
- `anthropic` → `POST /v1/messages` (Anthropic Claude direct; sends `anthropic-version: 2023-06-01`, `max_tokens: 1024`)

## Coding Style

- Tabs, LF, UTF-8, no trailing whitespace (see `.editorconfig`).
- Prettier: single quotes, semicolons, print width 140.
- `PascalCase` classes/types, `camelCase` functions/variables, `UPPER_SNAKE_CASE` constants.

## Security

- Never commit `wrangler.toml` with real secrets; `JWT_SECRET` and `AI_API_KEY` belong in Cloudflare Secrets.
- Email HTML preview uses DOMPurify + sandboxed iframe. Do not relax the sandbox.
- Do not log or return API key plaintext after creation; do not expose `raw` bodies to non-admin roles.

## Commit Style

Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`. Keep commits atomic.
