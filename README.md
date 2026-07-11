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
| `cloud.kiliw.com/checkout.html?gb=<tier>` | Checkout page: live USD→RUB rate (CBR, hourly cache in `_rates/`), promo codes (`_promo/`, percent off, optional max uses, validated server-side), payment method choice (YooKassa card / Heleket crypto). The plan modal redirects here. The site owner (`OWNER_EMAIL`) gets a "Site admin" section in the profile: promo management + user/file/storage stats (`/api/admin`) |
| `auth.kiliw.com` | Sign in / sign up. Signed in → redirect to `cloud.kiliw.com` |
| `cloud.kiliw.com` | The cloud app. Signed out → redirect to `auth.kiliw.com` |
| `*.workers.dev` / localhost | Same flows on a single host (no subdomain redirects) |

Sessions live in a `kiliw_session` cookie (30 days) scoped to
`.kiliw.com`. All data is stored in **one R2 bucket** (`kiliw-files`):

```
_auth/users/<email>.json      account records (PBKDF2-SHA256 password hashes)
_auth/sessions/<token>.json   sessions
u/<email>/<filename>          the user's files
_share/t/<token>.json         public share links (optional PBKDF2 password)
_share/f/<email>/<path>       file → share-token index
```

### Public share links

Any file or folder can be shared via `https://kiliw.com/share/<token>` —
a branded full-page viewer that works without an account: images, video,
audio, PDF and text files show a live preview (`?raw=1` streams inline,
`?dl=1` downloads); folder links show a browsable listing with per-file
downloads and previews (`?view=<rel>` / `?raw=<rel>` / `?dl=<rel>`) and
whole-folder ZIP downloads (`?zipdir=<rel>`, streamed by `lib/zip.js`;
in the cloud app the same lives at `/api/folder-zip?p=<path>` and in the
folder ⋯ menu). Classic ZIP only: archives are capped at ~4 GB.
When creating a link you choose who can open it: **anyone with the
link** (optionally password-protected) or **only people you choose** —
specific registered users added by email, who must be signed in
(`share.access` + `share.allowed` on the record; anonymous visitors get
a sign-in prompt). A signed-in visitor without access can press
**Request access**: the owner gets a notification (bell icon in the
cloud header, records in `_notif/`) and can allow it in one click; the
requester is notified back with a link. Public links can optionally
require a password; a correct password
unlocks the page via a short-lived signed URL (1 hour), so the file bytes
are never reachable without it. Shares follow renames and are removed
automatically when the file, its folder, or the account is deleted. One
link per file/folder; creating a new link replaces the old one.

### Folder editors (edit access by email)

The owner of a folder can grant edit access to other registered users by
email (share modal → Editors), and revoke it the same way. Granted folders
appear in the member's cloud under "Your files" with a "Shared by …" note;
inside, the member can upload, download, rename and delete files (all
storage counts against the owner's quota). Grants live in R2 under
`_collab/` (a member record plus an owner-side index) and are cleaned up
when the folder or either account is deleted.

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

## Email verification (Resend)

With mail configured, sign-up parks the account and emails a 6-digit
code (15-minute expiry, 5 attempts, 60 s resend cooldown); the account
is created only after the code is entered. Without mail configured,
sign-up works directly — nothing breaks.

1. Create an account at resend.com and verify the `kiliw.com` domain
   (add the DNS records it shows — they go into the same Cloudflare
   account).
2. Add the API key as a Worker secret **`RESEND_API_KEY`**.
3. Optional: set `MAIL_FROM` (defaults to `Kiliw <noreply@kiliw.com>`).

## Plans & billing

Free plan: up to 1 GB per file, 10 GB of storage. Pro tiers (USD, per
30 days): 250 GB — $4.99, 500 GB — $8.99, 1 TB — $17.99; up to 50 GB
per file. Large files upload in 64 MiB chunks through R2 multipart, so
the Workers per-request body limit is never exceeded.

Two payment methods, each enabled by its own secrets
(*Settings → Variables and Secrets → Secret*):

**YooKassa** (cards; charges RUB at a fixed 90 ₽/$ rate — adjust
`RUB_PER_USD` in `lib/api.js`):
1. Create a shop at yookassa.ru → secrets `YOOKASSA_SHOP_ID` and
   `YOOKASSA_SECRET_KEY`.
2. Webhook URL: `https://cloud.kiliw.com/api/yookassa`, event
   `payment.succeeded`.

**Heleket** (crypto):
1. Create a merchant at heleket.com → secrets `HELEKET_MERCHANT_ID`
   (merchant UUID) and `HELEKET_API_KEY` (payment API key).
2. Callback URL is passed automatically
   (`https://cloud.kiliw.com/api/heleket`).

Either way the plan also activates when the user returns to the site
after paying, so webhooks are a safety net rather than a requirement.

Note: the free tier of R2 itself is 10 GB total for the whole bucket —
storage beyond that is billed by Cloudflare to the bucket owner.

### 18+ content detection

Shared photos and videos whose names contain adult markers (porn/nsfw/xxx)
open censored: blurred behind a "Sensitive content" cover. Shared images
are additionally analyzed by **Workers AI** (LLaVA vision model, `ai`
binding in `wrangler.jsonc` — no manual setup, included in the Workers
free tier). Photos are checked **at upload time** in the background
(`waitUntil`), older files are backfilled a few per listing, and every
verdict is cached in `_mod/<email>/<path>.json` (moved on rename,
removed on delete). Censoring applies everywhere: in-app previews,
list thumbnails, share pages and shared-folder previews. Videos can't
be frame-analyzed inside a Worker, so they rely on the name check only.
If the model is unavailable, everything gracefully falls back to names.

## Developer API (DEV plan)

The **DEV** plan ($12.99 / 30 days, 500 GB, files up to 50 GB) unlocks
programmatic access. Keys are managed in the profile (API pane, up to 5;
the secret `kw_…` is shown once, only its SHA-256 hash is stored). All
requests use `Authorization: Bearer kw_…`:

```
GET    /api/v1/usage             plan + storage usage
GET    /api/v1/files?path=a/b    list folders and files
GET    /api/v1/files/<path>      download a file
PUT    /api/v1/files/<path>      upload (body = contents, ≤ 100 MB)
DELETE /api/v1/files/<path>      delete a file
POST   /api/v1/folders           {"path": "a/b"} create a folder
DELETE /api/v1/folders?path=a/b  delete a folder recursively
```

Uploads respect the plan's per-file and quota limits; images get the
same background 18+ moderation as web uploads. The site owner has API
access without a DEV subscription.

## Local development

```bash
npx wrangler dev
```

Note: the `ai` binding makes `wrangler dev` open a remote session, which
requires `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`). Without
credentials, temporarily remove the `ai` block from `wrangler.jsonc` —
the code degrades to name-based detection automatically.

R2 is emulated locally. The Turnstile test key is used automatically; if
`challenges.cloudflare.com` is unreachable the captcha check is skipped
in dev (it fails closed in production, where a real
`TURNSTILE_SECRET_KEY` is set).

## Health check

Open `/api/me` — a working deployment answers
`{"success":false,"error":"unauthorized"}` (or your email when signed
in). `{"error":"not-configured"}` means the R2 bucket is missing.
