# Kiliw — auth + cloud storage

Sign-in / sign-up protected by Cloudflare Turnstile (with optional TOTP
two-factor auth), and a personal file cloud (upload / download /
delete) with a profile popup for password change and 2FA setup. Frosted matte design with a coral
accent (`#D97757`). Runs as a **Cloudflare Worker** with static assets
(also compatible with Cloudflare Pages).

## How it works

| URL | Behaviour |
|---|---|
| `kiliw.com` | Dispatcher: signed out → `auth.kiliw.com`, signed in → `cloud.kiliw.com` |
| `auth.kiliw.com` | Sign in / sign up. Signed in → redirect to `cloud.kiliw.com` |
| `cloud.kiliw.com` | The cloud app. Signed out → redirect to `auth.kiliw.com` |
| `*.workers.dev` / localhost | Same flows on a single host (no subdomain redirects) |

Sessions live in a `kiliw_session` cookie (30 days) scoped to
`.kiliw.com`. All data is stored in **one R2 bucket** (`kiliw-files`):

```
_auth/users/<email>.json      account records (PBKDF2-SHA256 password hashes)
_auth/sessions/<token>.json   sessions
u/<email>/<filename>          the user's files
```

## Files

| Path | Purpose |
|---|---|
| `public/` | Static assets: auth page, cloud app, styles, fonts |
| `src/worker.js` | Worker entry: routes /api/*, auth-gates pages |
| `functions/` | The same handlers in Pages Functions layout (reused by the worker) |
| `functions/api/password.js` | POST — change password (signs out other sessions) |
| `functions/api/2fa.js` | POST — TOTP 2FA: setup / enable / disable |
| `lib/api.js` | Shared logic: users, sessions, PBKDF2, Turnstile |
| `wrangler.jsonc` | Worker config: assets dir + R2 binding |

## Cloudflare setup (one time)

The project deploys automatically from git (Workers Builds). To make it
fully work:

1. **R2 bucket** — dashboard → **R2** → *Create bucket* → name it exactly
   **`kiliw-files`**. The binding is declared in `wrangler.jsonc`, so no
   dashboard binding setup is needed — just redeploy after creating the
   bucket (Deployments → ⋯ → Retry, or push any commit).
2. **Domains** — Worker → *Settings → Domains & Routes* → add
   `kiliw.com`, `auth.kiliw.com` and `cloud.kiliw.com`.
3. **Turnstile** — Turnstile → *Add site* → domain `kiliw.com`. Put the
   **Site Key** into `TURNSTILE_SITE_KEY` in `public/auth.js`; add the
   **Secret Key** as a **secret** named `TURNSTILE_SECRET_KEY`
   (*Settings → Variables and Secrets → Add → Secret*). Until then the
   test key is used — the captcha shows "For testing only" and always
   passes.

If the build fails, check *Settings → Build* — the deploy command should
be `npx wrangler deploy` (default).

## Plans & billing (YooKassa)

Free plan: up to 1 GB per file, 10 GB of storage. Pro (paid via
YooKassa): up to 50 GB per file, user-selected storage from 50 GB to
1 TB, 1.5 ₽/GB per 30 days (min 149 ₽). Large files upload in 64 MiB
chunks through R2 multipart, so the Workers per-request body limit is
never exceeded.

To enable payments:

1. Create a shop at yookassa.ru, take **shopId** and the **secret key**.
2. Add both as Worker secrets: `YOOKASSA_SHOP_ID` and
   `YOOKASSA_SECRET_KEY` (*Settings → Variables and Secrets → Secret*).
3. In the YooKassa dashboard set the HTTP notification (webhook) URL to
   `https://cloud.kiliw.com/api/yookassa` and subscribe to
   `payment.succeeded`. (Even without the webhook the plan activates
   when the user returns to the site after paying.)

Note: the free tier of R2 itself is 10 GB total for the whole bucket —
storage beyond that is billed by Cloudflare to the bucket owner.

## Local development

```bash
npx wrangler dev
```

R2 is emulated locally. The Turnstile test key is used automatically; if
`challenges.cloudflare.com` is unreachable the captcha check is skipped
in dev (it fails closed in production, where a real
`TURNSTILE_SECRET_KEY` is set).

## Health check

Open `/api/me` — a working deployment answers
`{"success":false,"error":"unauthorized"}` (or your email when signed
in). `{"error":"not-configured"}` means the R2 bucket is missing.
