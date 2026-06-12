# Fix Cloudflare Deploy (read this first)

## The problem (one sentence)

Git is hooked to the **wrong thing** (a Worker). It needs to be hooked to **Pages**, or the deploy command must change.

---

## Fix it in 5 minutes (click by click)

### Step 1 — Open Cloudflare

Go to: https://dash.cloudflare.com  
Log in.

### Step 2 — Find the broken one

Click **Workers & Pages** (left sidebar).

You may see **two** things named `flightway`. Open the one that says **Worker** (not Pages).

### Step 3 — Change the deploy command

1. Click **Settings**
2. Click **Build** (or **Builds**)
3. Find **Deploy command**
4. **Delete** what's there (`npx wrangler deploy`)
5. Type exactly:

```
npm run deploy
```

6. Click **Save**

### Step 4 — Retry

Go to **Deployments** → click **Retry deployment** on the failed one.

---

## Better fix (recommended)

Use **Pages** only. Delete or disconnect Git from the **Worker**.

1. **Workers & Pages** → open the **Worker** named `flightway`
2. **Settings** → **Git** → **Disconnect**
3. Open the **Pages** project `flightway` (URL ends in `.pages.dev`)
4. **Settings** → **Builds**:
   - Build command: **leave empty**
   - Output directory: **`.`**
   - Deploy command: **leave empty**
5. Connect GitHub repo `flightway-ai/flightway` to **Pages** (not Worker)

---

## Shared account (no personal email)

**You do NOT need a shared Cloudflare login email.**

1. Pick **one cofounder** (any email — work email is fine)
2. They sign up at https://dash.cloudflare.com (free)
3. They create the Pages project and add secrets
4. They invite you + other cofounder: **Manage Account → Members → Invite**
5. Everyone uses **their own email** to log in — you all see the same Flightway account

No `billing@flightway.ai` required. Any cofounder's email can own the account; others get invited.

---

## After it works

Site: https://flightway.pages.dev

Still need (one time, in Pages → Settings → Variables):
- `GEMINI_API_KEY`
- `RESEND_API_KEY`
