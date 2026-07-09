# Synestix — auth page

Minimal sign-in / sign-up page with a single coral accent color (`#D97757`)
and Cloudflare Turnstile captcha.

## Files

| File | Purpose |
|---|---|
| `index.html` | Sign in / sign up page |
| `styles.css` | Minimal styles, light & dark theme |
| `auth.js` | Tabs, validation, Turnstile, submit logic |
| `functions/api/verify.js` | Cloudflare Pages Function — server-side token verification |

## Run locally

Open `index.html` in a browser, or serve statically:

```bash
npx serve .
```

The page currently uses Cloudflare's **test Turnstile key**
(`1x00000000000000000000AA`) — it renders on any domain and always passes.

## Enable real captcha

1. In the Cloudflare dashboard open **Turnstile → Add site** and add your domain.
2. Put the **Site Key** into `TURNSTILE_SITE_KEY` in `auth.js`.
3. Put the **Secret Key** into the `TURNSTILE_SECRET_KEY` environment variable
   (Cloudflare Pages: *Settings → Environment variables*).

## Deploy to Cloudflare Pages

```bash
npx wrangler pages deploy .
```

The `functions/` directory is picked up automatically — `/api/verify`
verifies the Turnstile token server-side via `siteverify`. If the site is
hosted elsewhere, port the logic from `functions/api/verify.js` to your
backend (it is a plain POST request to
`https://challenges.cloudflare.com/turnstile/v0/siteverify`).
