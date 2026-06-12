# AI Coach — Cloudflare Pages Setup

Flightway's AI career coach uses **Cloudflare Pages Functions** (in `/functions/`) and **Workers KV** for per-user dossiers and chat state.

**Live site:** https://flightway.pages.dev  
**Quiz + coach app:** https://flightway.pages.dev/Flightway.html

---

## Cloudflare Dashboard build settings (important)

You likely have **two** things named `flightway`:

| Type | What it is | Git deploy behavior |
|---|---|---|
| **Worker** (Workers Builds) | Wrong for this repo — defaults to `npx wrangler deploy` | **This is what’s failing** |
| **Pages** project | Correct — static HTML + `/functions/` | Auto-uploads assets (no deploy command) |

### Fix option A (recommended): use Pages, not Worker

1. **Workers & Pages → flightway (Worker)** → Settings → Git → **Disconnect** (or delete this Worker)
2. **Workers & Pages → flightway (Pages)** → Settings → Builds:
   - Build command: *(empty)*
   - Build output directory: **`.`**
   - Deploy command: ***(empty)***
3. Connect Git to the **Pages** project, not the Worker

Live site: **https://flightway.pages.dev**

### Fix option B: keep Worker Git build

If Git is connected to the **Worker**, set **Deploy command** to:

```bash
npm run deploy
```

(`package.json` includes this script → `wrangler pages deploy . --project-name=flightway`)

Do **not** use `npx wrangler deploy` — that command is for Workers scripts, not this static Pages site.

---

## Already configured (via Wrangler)

| Item | Status |
|---|---|
| Pages project `flightway` | Created |
| Production KV `COACH_KV` | Bound (`14129792fcce40dabe02380aff80d055`) |
| Preview KV `COACH_KV` | Bound (`5a3893c3048b45e3a2bf6dfdcca92e65`) |
| `FROM_EMAIL`, `GEMINI_MODEL`, etc. | Set on project |
| Initial deploy | Success |

## You still need to add (2 secrets)

These cannot be set from code — paste your keys once:

```bash
cd /path/to/flightway
npx wrangler pages secret put GEMINI_API_KEY --project-name=flightway
npx wrangler pages secret put RESEND_API_KEY --project-name=flightway
```

Or in **Cloudflare Dashboard → Workers & Pages → flightway → Settings → Variables and Secrets** (mark both as **Encrypted**).

- **GEMINI_API_KEY** — from [Google AI Studio](https://aistudio.google.com/app/apikey)
- **RESEND_API_KEY** — from [Resend](https://resend.com) (starts with `re_`)

After adding secrets, redeploy (push to `main` if GitHub Actions is set up, or run `npx wrangler pages deploy . --project-name=flightway`).

---

## GitHub → Cloudflare (if dashboard Git connect fails)

A GitHub Action deploys on every push to `main`. Add these **repository secrets** in `flightway-ai/flightway` → Settings → Secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Cloudflare Pages Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | `398e05028ea9e4baabaac9809e01eca4` |

Workflow file: `.github/workflows/deploy-pages.yml`

---

## 1. Create a Cloudflare Pages project (manual alternative)

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
