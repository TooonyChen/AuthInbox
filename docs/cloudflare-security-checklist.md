# Cloudflare Free Security Checklist

This project keeps Basic Auth in the Worker and expects Cloudflare edge controls as the second layer.

## 1) Access on Worker Route

1. Open Cloudflare Dashboard → `Workers & Pages` → your Worker.
2. In `Settings` → `Domains & Routes`, enable Cloudflare Access on `workers.dev` (or your custom domain route).
3. Add an Access policy that allows only your emails/identity provider group.

## 2) WAF Managed Rules

1. Open Dashboard → your zone → `Security` → `WAF`.
2. Ensure Cloudflare Managed Ruleset is deployed.
3. Keep default managed protections enabled unless you need a specific exclusion.

## 3) Rate Limiting for API

1. Open Dashboard → your zone → `Security` → `WAF` → `Rate limiting rules`.
2. Create a rule for path `/api/*`.
3. Suggested baseline:
   - Action: `Managed Challenge` or `Block`
   - Scope: per IP
   - Threshold: `60 requests / 1 minute`
4. Keep login-protected UI and API behind both Access and Basic Auth.

## 4) Secrets Hygiene

Use Worker secrets for sensitive values:

- `FrontEndAdminPassword`
- `AI_API_KEY`
- `AI_FALLBACK_API_KEY` (if fallback enabled)
- `barkTokens` (if Bark enabled)

Set with:

```bash
corepack pnpm exec wrangler secret put <KEY>
```
