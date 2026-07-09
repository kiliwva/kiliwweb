# Kiliw — auth + cloud storage

Sign-in / sign-up protected by Cloudflare Turnstile, and a personal file
cloud (upload / download / delete). Frosted matte design with a coral
accent (`#D97757`), built for Cloudflare Pages.

## How it works

| URL | Behaviour |
|---|---|
| `kiliw.com` | Signed out → redirect to `auth.kiliw.com`. Signed in → cloud app |
| `auth.kiliw.com` | Sign in / sign up. Signed in → redirect to `kiliw.com` |
| `*.pages.dev` / localhost | Same flows on a single host (no subdomain redirects) |

Sessions live in a `kiliw_session` cookie (30 days) scoped to
`.kiliw.com`, so signing in on `auth.kiliw.com` also signs you in on
`kiliw.com`.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `auth.js` | Auth page (Turnstile, sign in / sign up) |
| `cloud.html`, `cloud.js` | Cloud app (list, upload, download, delete) |
| `styles.css`, `fonts/` | Shared styles, self-hosted Manrope |
| `functions/_middleware.js` | Host/session routing |
| `functions/api/login.js` | POST — verify captcha + credentials, create session |
| `functions/api/register.js` | POST — verify captcha, create user + session |
| `functions/api/logout.js` | POST — destroy session |
| `functions/api/me.js` | GET — current user |
| `functions/api/files/index.js` | GET list / POST upload |
| `functions/api/files/[name].js` | GET download / DELETE |
| `lib/api.js` | Shared helpers (sessions, PBKDF2, Turnstile) |

Passwords are stored as PBKDF2-SHA256 hashes (100k iterations, per-user
salt). Files are stored in R2 under `u/<email>/<filename>` — each user
only ever sees their own prefix.

## Cloudflare setup (one time)

1. **KV** — Dashboard → Workers & Pages → KV → *Create namespace* (e.g.
   `kiliw-auth`). In the Pages project: *Settings → Bindings → Add → KV
   namespace*, variable name **`KILIW_KV`**.
2. **R2** — R2 → *Create bucket* (e.g. `kiliw-files`). Add a Pages
   binding: *R2 bucket*, variable name **`KILIW_FILES`**.
3. **Turnstile** — Turnstile → *Add site* → domain `kiliw.com` (covers
   subdomains). Put the **Site Key** into `TURNSTILE_SITE_KEY` in
   `auth.js`; add the **Secret Key** as an environment variable
   **`TURNSTILE_SECRET_KEY`** (*Settings → Environment variables*,
   type Secret). Until then the test key is used — the captcha shows
   "For testing only" and always passes.
4. **Domains** — Pages project → *Custom domains* → add both
   `kiliw.com` and `auth.kiliw.com`.

Redeploy after adding bindings.

## Local development

```bash
npx wrangler pages dev . --kv KILIW_KV --r2 KILIW_FILES
```

KV and R2 are emulated locally; the Turnstile test key is used
automatically, and if `challenges.cloudflare.com` is unreachable the
captcha check is skipped in dev (it fails closed in production, where a
real `TURNSTILE_SECRET_KEY` is set).
