# Setting up the AI Coach (the "explain it like I'm five" version)

This guide walks you through turning on the AI Career Coach for the Flightway site. You don't need to know how to code. You will copy & paste a few things into the Netlify website. Total time: **about 10 minutes**.

When you're done, users who finish the quiz will be able to:

- Click "Create free account" with just their email.
- Chat with an AI career coach that remembers them.
- View and edit their "dossier" (the coach's memory of them).

---

## Before you start — what you need

1. **Access to the Netlify site** for Flightway. This is where the site is hosted. If you can log into Netlify and see this project listed there, you're good.
2. **A Google account.** Any Gmail will do.
3. **About 10 minutes.**

You do **not** need to install anything on your computer.

---

## Step 1 — Get a free Gemini API key (3 minutes)

Gemini is Google's AI. We get to use it for free up to a generous daily limit. No credit card needed.

1. Open this link in a new tab: <https://aistudio.google.com/app/apikey>
2. Sign in with your Google account if it asks.
3. You should see a page called **"API keys"**. Click the blue **"Create API key"** button.
4. If it asks you to pick a project, just pick anything — the default one is fine. Click **"Create API key in new project"**.
5. A box will pop up with a long string of letters and numbers, something like:

   ```
   AIzaSyB...........................abc
   ```

6. **Copy that whole string.** This is your API key. Keep it secret — it's like a password.

> If you lose it, no big deal — come back to this page and create a new one.

---

## Step 2 — Tell Netlify about your API key (2 minutes)

The website needs to know your API key so it can talk to Gemini. We give it to Netlify (not to anyone else) by putting it in a special hidden place called "Environment variables".

1. Go to <https://app.netlify.com> and log in.
2. Click on your Flightway site (it'll be in the list of sites).
3. On the left sidebar, click **Site configuration** (the gear icon ⚙).
4. In the sub-menu that appears, click **Environment variables**.
5. Click the **"Add a variable"** button.
6. Choose **"Add a single variable"**.
7. Fill in the two boxes:
   - **Key:** type exactly `GEMINI_API_KEY` (all caps, with the underscore)
   - **Values:** paste the long API key string you copied in Step 1.
8. Leave everything else at the defaults. Click **"Create variable"**.

That's it. The key is now safely stored on Netlify, and only the website's backend can see it.

> **Optional second variable:** if you want to use a different Gemini model later, you can add another variable called `GEMINI_MODEL` with a value like `gemini-2.5-flash-lite` (cheaper) or `gemini-3-flash-preview` (smarter). If you skip this, the site uses `gemini-2.5-flash` by default. **For the MVP, skip this — the default is the best choice.**

---

## Step 3 — Turn on Netlify Blobs (1 minute)

"Blobs" is Netlify's free storage. We use it to remember each user's dossier. On most Netlify accounts it's on by default — but let's make sure.

1. Still in your site's settings on Netlify, click **Site configuration** in the left sidebar.
2. Look for a section called **"Netlify Blobs"** (it might be under "Storage" or "Add-ons").
3. If you see a button that says "Enable Blobs" or "Get started with Blobs", click it.
4. If it's already enabled, you'll see something like "Blobs is active" — nothing to do.

> If you can't find the Blobs section anywhere, don't worry — Netlify usually turns it on automatically the first time the website tries to use it. Just continue.

---

## Step 4 — Push the new code to your site (2 minutes)

The new AI Coach files need to get from this folder onto Netlify so the live site has them.

If you're using GitHub (which you are), pushing is what triggers a fresh deploy. From a terminal in this folder:

```bash
git add .
git commit -m "Add AI career coach"
git push
```

Netlify watches your repo. About **1–2 minutes** after you push, it'll automatically rebuild the site with the new coach included.

> **How to know when it's done:** go to your site on Netlify and look at the **Deploys** tab. The top entry should say "Published" with a green checkmark. If it says "Failed", click into it to see the error — most often it's a typo in the environment variable name from Step 2.

---

## Step 5 — Test it (2 minutes)

1. Open your live site (the `.netlify.app` URL or your custom domain).
2. Click **"Take the Quiz"** and finish the quiz (or click "Just show me my results →" if you've already done it).
3. Scroll to the bottom of the results page. You should see a **blue card** that says **"Want more than the quiz?"**.
4. Click **"Create free account →"**. Type your email. Click **"Create account →"**.
5. You should land on the **AI Coach** page with a chat box at the bottom.
6. Type a message like "What majors should I consider?" and press Enter.
7. After a couple seconds, the coach replies.

**Try sending 5 messages.** After the 5th reply, you'll see:

- A blue banner that says **"Updating dossier — committing what your coach learned to memory…"**
- The chat clears.
- A small italic note appears: **"✓ Memory refreshed."**

Then click the ⚙ gear icon at the top of the coach page. You'll see a **dossier editor** — a text box with everything the coach remembers about you. You can edit it directly and click **Save dossier**.

🎉 If all that works, you're done.

---

## Troubleshooting

### "AI service is not configured" error when I send a message

Your `GEMINI_API_KEY` either isn't set, is misspelled, or the site hasn't redeployed since you set it.

- Double-check the variable name in Netlify is exactly `GEMINI_API_KEY`.
- After adding the variable, go to **Deploys** → click **"Trigger deploy"** → **"Deploy site"** to force a fresh build.

### Chat replies are slow or time out

The 5th message takes longer (~3–5 seconds) because the coach is also updating the dossier in the background. That's normal. Replies 1–4 should be quick (~1–2 seconds).

If everything is slow, you may have hit the free-tier rate limit (10 chat messages per minute). Wait a minute and try again.

### "Could not save dossier" — must start with `# user dossier v1`

The dossier has a required format. The first line must literally be `# user dossier v1` and it must contain the standard sections (`top_industries:`, `interests:`, `goals:`, `recent:`). If you mangled it while editing, click the **↻ Reload** button to get the last saved version back.

### The blue results card never appears

Hard-refresh the page (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows). If still missing, check that the new deploy on Netlify was Published, not Failed.

### "Could not create account" error on signup

The most common cause is Netlify Blobs not being available. Check Step 3 again.

---

## How much does this cost?

- **Hosting:** Free (Netlify free tier).
- **Storage:** Free (Netlify Blobs free tier — easily covers thousands of users).
- **The AI itself:** **Free** while you stay under Gemini's free tier (~1,500 requests per day on the Flash model). Each user "session" of 5 chat messages uses about 6 requests. So that's roughly **250 active users per day** before you'd ever see a bill.
- If you ever grow past that: cost is around **$0.001 (one tenth of a cent) per full 5-message session**. Switching to a paid Gemini tier is one button click in Google AI Studio.

So for the MVP and a long time after, this is genuinely $0/month on top of what you already pay (nothing).

---

## What lives where (for the curious)

- `Netlify/Functions/account.js` — handles "create account from email"
- `Netlify/Functions/chat.js` — handles each chat message; calls Gemini; runs the 5-exchange reset
- `Netlify/Functions/dossier.js` — handles reading/saving the dossier from the settings panel
- `Netlify/Functions/_lib.js` — shared helpers (the underscore prefix tells Netlify "this is a library, not an endpoint")
- `Flightway.html` — all the front-end stuff (the new Coach tab, signup modal, settings panel)
- `package.json` — tells Netlify to install the `@netlify/blobs` library

---

## What to do if you want to change the AI's behavior

The coach's personality and instructions live in `Netlify/Functions/chat.js`, in a function called `chatSystemPrompt`. Right now it says things like "Speak directly and concretely. Avoid generic advice." You can edit those instructions, push the change, and Netlify will redeploy.

The dossier update rules live in the same file, in `dossierUpdatePrompt`. Edit there to change how the coach summarizes what it remembers.

---

That's the whole setup. Good luck — and if something breaks, the first thing to check is always **the Deploys tab in Netlify** for build errors.
