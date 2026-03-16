# Repository Guidelines

## Project Structure

- `src/index.ts` — Cloudflare Worker entrypoint: HTTP auth gate, REST API (`/api/mails`, `/api/mails/:id`), email handler, AI extraction, D1 writes, promotional filter.
- `src/rpcEmail.ts` — RPC-compatible `ForwardableEmailMessage` wrapper.
- `web/` — React 18 + Vite + Tailwind + shadcn/ui frontend. Built to `web/dist`, served via Cloudflare `ASSETS` binding.
- `db/schema.sql` — D1 schema: `raw_mails` (every incoming email) + `code_mails` (AI-extracted codes only).

## Commands

```bash
# Install
pnpm install                     # root (Worker) deps
# Dev
pnpm run dev                     # wrangler dev — local Worker on :8787
pnpm run dev:remote              # wrangler dev --remote — use live D1
pnpm -C web run dev              # Vite dev server on :5173 (proxies /api → :8787)
# Build & deploy
pnpm run build:web               # vite build → web/dist
pnpm run deploy                  # build:web + wrangler deploy
# Misc
pnpm run test                    # vitest with @cloudflare/vitest-pool-workers
pnpm run cf-typegen              # regenerate Worker type bindings
```

Local setup:
```bash
cp wrangler.toml.example wrangler.toml   # fill in database_id + secrets
pnpm wrangler d1 execute inbox-d1 --local --file=db/schema.sql
pnpm run build:web
pnpm run dev
```

## Architecture Constraints

- **Promotional filter runs before LLM.** `isPromotionalEmail()` checks `List-Unsubscribe`, `List-ID`, `Precedence: bulk/list`, and known ESP X-headers. If matched, raw email is still saved to `raw_mails` but LLM is skipped.
- **Two DB tables, strict separation.** Every email → `raw_mails`. Only emails with extracted codes/links → `code_mails`. Never skip `raw_mails` insert.
- **`ASSETS` is required for the frontend.** The Worker serves the React app from the `ASSETS` binding; there is no legacy HTML fallback.
- **`web/dist` is gitignored.** Built at deploy time via `pnpm run deploy`. No need to commit build artifacts.
- **`ASSETS` binding name must be `ASSETS`** (matched in `src/index.ts` as `env.ASSETS`).
- **Base64 MIME parts** are decoded with `atob()` in `extractMailBodies()`. Cloudflare Workers runtime supports `atob`/`btoa`.

## AI Provider Configuration

The AI layer uses a single unified function `callProvider(config: ProviderConfig, prompt)` in `src/index.ts`. All provider-specific logic is contained there — do not add new per-provider methods.

**Env vars (set in `wrangler.toml` `[vars]` or as Cloudflare Secrets):**

| Variable | Required | Description |
|---|---|---|
| `AI_BASE_URL` | ✅ | Provider base URL, no trailing slash |
| `AI_API_KEY` | ✅ | API key (use Secret in production) |
| `AI_API_FORMAT` | ✅ | `openai` \| `responses` \| `anthropic` |
| `AI_MODEL` | ✅ | Model ID |
| `AI_FALLBACK_BASE_URL` | optional | Fallback provider base URL |
| `AI_FALLBACK_API_KEY` | optional | Fallback API key |
| `AI_FALLBACK_API_FORMAT` | optional | Fallback format |
| `AI_FALLBACK_MODEL` | optional | Fallback model ID |

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

- Never commit `wrangler.toml` with real secrets.
- `web/src/App.tsx` uses DOMPurify + sandboxed iframe for email HTML preview. Do not relax sandbox.
- Basic Auth gate is enforced at the top of `WorkerEntrypoint.fetch()` before any API route.

## Commit Style

Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`. Keep commits atomic.
