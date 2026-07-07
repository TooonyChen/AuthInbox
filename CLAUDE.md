# CLAUDE.md

## Stack

Cloudflare Worker (TypeScript + Hono) + React 18 + Vite + Tailwind + shadcn/ui + Cloudflare D1 + remote MCP server (`@hono/mcp`).

Package manager: **pnpm**. Never use npm commands.

## Key Commands

```bash
pnpm run dev               # Worker backend :8787
pnpm run dev:web           # React frontend :5173 (proxy /api → :8787)
pnpm run db:migrate:local  # apply D1 migrations locally
pnpm run deploy            # build:web + db:migrate:remote + wrangler deploy
pnpm run test
```

## Architecture Boundaries — Never Violate

1. `isPromotionalEmail()` must run **before** any LLM call in the email handler (`src/email/handler.ts`).
2. Every incoming email → `raw_mails`. Only AI-extracted results → `code_mails`. Never skip `raw_mails`.
3. `ASSETS` is required for the frontend. There is no legacy HTML fallback.
4. DOMPurify + sandboxed iframe on all email HTML rendering. Do not relax.
5. Auth boundaries are middleware in `src/app.ts`: `sessionAuth` on `/api/*`, `requireAdmin` on `/api/admin/*`, `apiKeyAuth` on `/mcp`. Do not move or bypass.
6. `visibleMails()` (`src/services/mail.ts`) is the **only** mail permission layer — REST and MCP both query through it. Never add a parallel filter path.
7. Sensitive categories (`password_reset`, `account_security`) are default-deny for users; `legacy` and raw email bodies are admin-only on every interface.
8. All AI calls go through `callProvider()` (`src/services/classify.ts`). Do not add per-provider methods alongside it.
9. Schema changes = new numbered file in `migrations/`. Never edit applied migrations.

## Env Vars

Required: `AI_BASE_URL`, `AI_API_KEY`, `AI_API_FORMAT` (`openai`|`responses`|`anthropic`), `AI_MODEL`, `JWT_SECRET` (Cloudflare secret, signs session JWTs).
Optional fallback: `AI_FALLBACK_BASE_URL`, `AI_FALLBACK_API_KEY`, `AI_FALLBACK_API_FORMAT`, `AI_FALLBACK_MODEL` (all four or none).
Optional Bark push: `UseBark`, `barkUrl`, `barkTokens`.

## Frontend Component Rules

- UI components: shadcn/ui only. No new UI libraries without discussion.
- Colors: CSS variables in `web/src/index.css`. No hardcoded hex except table hover states.
- Use `text-muted-foreground` for secondary text. `text-muted` is a background color — never use as text.
- All grid children need `min-w-0` to prevent overflow.

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)
