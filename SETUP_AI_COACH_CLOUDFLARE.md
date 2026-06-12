# AI Coach — Cloudflare Pages Setup

Flightway's AI career coach uses **Cloudflare Pages Functions** (in `/functions/`) and **Workers KV** for per-user dossiers and chat state.

## 1. Create a Cloudflare Pages project

1. Connect the [flightway-ai/flightway](https://github.com/flightway-ai/flightway) repo in **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**.
2. Build settings: **Framework preset = None**, build command empty, **Build output directory = `.`** (root).

## 2. Create and bind KV

```bash
npx wrangler kv namespace create COACH_KV
npx wrangler kv namespace create COACH_KV --preview
```

In **Pages → your project → Settings → Functions → KV namespace bindings**:

| Variable name | KV namespace |
|---|---|
| `COACH_KV` | `COACH_KV` (production) |

Optionally add the namespace ids to `wrangler.toml` for local `wrangler pages dev`.

## 3. Environment variables

In **Pages → Settings → Variables and Secrets**:

| Variable | Secret? | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | From [Google AI Studio](https://aistudio.google.com/) |
| `GEMINI_MODEL` | No | Optional, default `gemini-2.5-flash-lite` |
| `GEMINI_FALLBACK_MODEL` | No | Optional, default `gemini-2.0-flash` |
| `GEMINI_USE_SEARCH` | No | `auto` (default), `always`, or `never` |
| `RESEND_API_KEY` | Yes | From [Resend](https://resend.com) |
| `FROM_EMAIL` | No | e.g. `Flightway <quiz@flightway.ai>` |
| `ALLOWED_ORIGIN` | No | e.g. `https://flightway.ai` (CORS) |

Redeploy after adding secrets.

## 4. API routes

| Route | Method | Purpose |
|---|---|---|
| `/send-results` | POST | Email quiz results link (Resend) |
| `/account` | POST | Create / restore coach account |
| `/chat` | POST | AI coach chat |
| `/dossier` | GET, PUT | Read / edit user dossier |

## 5. Local development

```bash
npm install -g wrangler
wrangler pages dev . --kv COACH_KV=YOUR_PREVIEW_KV_ID
```

Create a `.dev.vars` file (gitignored) for local secrets:

```
GEMINI_API_KEY=...
RESEND_API_KEY=...
FROM_EMAIL=Flightway <onboarding@resend.dev>
```

## 6. Custom domain

In **Pages → Custom domains**, add your domain after DNS is configured at your registrar.
