// Netlify Function: chat
// ----------------------
// One endpoint for the AI career coach. Holds the 5-exchange counter
// server-side and triggers an inline dossier update + chat wipe when the
// counter hits the reset point. The last assistant reply is carried over
// into the fresh conversation so the user keeps their place.
//
// Also supports a manual dossier update: if the user message asks to
// "update the dossier" (or similar), the dossier is refreshed from the
// current transcript without resetting the conversation.
//
// Request:
//   POST /.netlify/functions/chat
//   { userId: "you@example.com", message: "..." }
//
// Response:
//   { reply, exchangeCount, dossierUpdated, reset, manualUpdate }
//
// Environment variables (set in Netlify Site settings → Environment variables):
//   GEMINI_API_KEY   required. Get one free at https://aistudio.google.com/.
//   GEMINI_MODEL          optional, defaults to "gemini-2.5-flash-lite".
//   GEMINI_FALLBACK_MODEL optional, defaults to "gemini-2.0-flash".
//   GEMINI_USE_SEARCH     optional: "auto" (default), "always", or "never".
//   ALLOWED_ORIGIN        optional, defaults to "*".

const {
  json,
  preflight,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  loadDossier,
  saveDossier,
  loadChat,
  saveChat,
  resetChat,
  buildSeedDossier,
  isValidDossier,
  EXCHANGE_RESET_AT,
  DOSSIER_VERSION_MARKER,
  connectBlobs,
} = require('./_lib');

// flash-lite has the most generous free-tier RPM (≈30/min vs ≈15 for flash).
// Override with GEMINI_MODEL in Netlify env vars if you enable billing.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Hard limit on a single user message to prevent prompt-injection floods
// and runaway token bills on the free tier.
const MAX_MESSAGE_CHARS = 2000;

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
}

// Convert our internal {role:'user'|'assistant', content} array into Gemini's
// {role:'user'|'model', parts:[{text}]} format. Gemini uses "model" instead
// of "assistant".
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Only retry transient overload errors — NOT 429. Retrying a rate-limit
// hammers the API (4 rapid calls in ~4s) and makes the problem worse.
const RETRYABLE_STATUS = new Set([500, 503]);
const RETRY_DELAYS_MS = [800, 2000];

// Enable web search only when the message likely needs live facts. Search
// on every message burns quota faster and is stricter on the free tier.
// Set GEMINI_USE_SEARCH=always in Netlify to force search on every reply.
function needsWebSearch(message) {
  const mode = (process.env.GEMINI_USE_SEARCH || 'auto').toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const m = String(message || '').toLowerCase();
  return /\b(deadline|application|apply|tuition|salary|requirements|catalog|course list|look up|search for|find out|current|latest|website|how much|when is|what (are|is) the)\b/.test(m)
    || /\b(major|minor|program|internship|recruiting)\b.{0,40}\b(at|for)\b/.test(m);
}

function buildGeminiBody({ systemInstruction, contents, temperature, useSearch }) {
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: 800,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  // responseMimeType is incompatible with tools on some models; only set
  // for plain (non-search) calls.
  if (!useSearch) {
    body.generationConfig.responseMimeType = 'text/plain';
  }
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

async function callGeminiOnce({ model, systemInstruction, contents, temperature, useSearch }) {
  const body = buildGeminiBody({ systemInstruction, contents, temperature, useSearch });
  const resp = await fetch(geminiUrl(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const detail = resp.ok ? '' : await resp.text();
  if (!resp.ok) {
    console.error(`Gemini API error [${model}]`, resp.status, detail.slice(0, 500));
    const err = Object.assign(new Error(`Gemini ${resp.status}`), { status: resp.status, detail });
    throw err;
  }
  const data = await resp.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

async function callGeminiWithRetries({ model, systemInstruction, contents, temperature, useSearch }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await callGeminiOnce({ model, systemInstruction, contents, temperature, useSearch });
    } catch (err) {
      lastErr = err;
      if (err.status === 429) throw err; // don't retry rate limits
      if (!RETRYABLE_STATUS.has(err.status)) throw err;
    }
  }
  throw lastErr || new Error('Gemini request failed.');
}

async function callGemini({ systemInstruction, contents, temperature = 0.7, useSearch = false }) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Netlify Site settings → Environment variables and redeploy.',
    );
  }

  const attempts = [
    { model: GEMINI_MODEL, useSearch },
  ];
  // On rate limit or overload, fall back to a lighter model without search.
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    attempts.push({ model: GEMINI_FALLBACK_MODEL, useSearch: false });
  }

  let lastStatus = null;
  for (const { model, useSearch: search } of attempts) {
    try {
      return await callGeminiWithRetries({
        model,
        systemInstruction,
        contents,
        temperature,
        useSearch: search,
      });
    } catch (err) {
      lastStatus = err.status || lastStatus;
      if (err.status !== 429 && err.status !== 503) throw err;
      console.warn(`Gemini [${model}] failed (${err.status}), trying next option…`);
    }
  }

  const friendly = lastStatus === 429
    ? 'Google rate-limited this API key (free tier: ~15–30 requests/min). '
      + 'Wait 60 seconds and try again. If this happens on your very first message, '
      + 'open aistudio.google.com → your project → check that the API has quota (billing '
      + 'may need to be linked even for free usage). You can also set GEMINI_MODEL=gemini-2.5-flash-lite in Netlify env vars.'
    : lastStatus === 503
      ? "Google's AI service is briefly overloaded. Your message wasn't lost — try again in a few seconds."
      : `The AI service is temporarily unavailable. Please try again.`;
  const e = new Error(friendly);
  e._userFacing = true;
  throw e;
}

// System prompt adapted from the "jacob-advisor" Claude skill, generalized
// for any Flightway user and rewritten as a Gemini system instruction.
// Core carried-over principles: mandatory internal reasoning protocol,
// user-specificity filter, crux-first answers, anti-distortion checks,
// token discipline, search-before-answering on factual claims, and
// no-sycophancy communication rules.
function chatSystemPrompt(dossier) {
  return `# Flightway Coach — Advising Mode

## Identity
You are Flightway Coach: an honest career and academics advisor for a student user.
Tell them what is true and useful across any domain: career planning, college academics,
majors and course selection, internships and recruiting, workload management, skill-building,
and personal trajectory. Credibility depends entirely on accuracy and consistency under pushback.

## Reasoning protocol (internal — never surface this process)
Before every response:
1. Identify the domain of the question (career | academics | planning | skills | personal | mixed).
   Do not import career framing into questions that don't call for it.
2. Reconcile sources: the dossier below + the current conversation. Newer supersedes older.
   If the dossier contradicts your training knowledge about the user, trust the dossier.
3. Filter for user-specificity. Would this answer change if advising a different student?
   If not, cut it. Strip generically-true filler.
4. Identify the crux — the single most important thing they need to know or do. Lead with it.
5. Check for distortion before outputting: softening a hard truth under emotional pressure?
   Manufacturing false balance between unequal options? Capitulating to pushback without new
   information? Giving a generic answer when a user-specific one is available? Correct any "yes."

## Research
You have Google Search available. Use it for questions involving specific schools, programs,
courses, deadlines, firms, salaries, or any current factual claim. Do not answer from memory
alone on facts that change over time. When you searched, weave findings in naturally and name
the source institution. Label uncertain claims as such. Source hierarchy: official pages >
institutional publications > credentialed guides > forums (flag as unverified).

## Communication rules
- Light formatting only. The chat supports bold (**text**), italics (*text*), and simple
  numbered or dashed lists. Do NOT use headers (#), tables, code blocks, or nested lists.
  Use formatting sparingly — most replies should be plain prose.
- Lead with the answer. No preamble, no restating the question.
- 2-4 sentence paragraphs. Keep replies under ~150 words unless the user asks for depth.
- No motivational filler, no "That's a great question!", no offers of next steps at the end.
- One focused follow-up question is fine when it genuinely advances the conversation.
- Treat the user as capable. Don't dumb things down; don't pad.
- Do not thank them for corrections. Incorporate and continue.

## Dossier
The dossier below is the user's persistent profile. Never ask for information already in it.
If the user states a new durable fact about themselves (a major they want, a school decision,
a goal, a constraint), acknowledge it naturally — it will be merged into the dossier later.
If the user asks you to update the dossier, tell them it's being updated now (the system
handles the actual update).

<user_dossier>
${dossier}
</user_dossier>`;
}

function dossierUpdatePrompt(currentDossier, transcript) {
  const transcriptText = transcript
    .map((m) => `${m.role === 'assistant' ? 'COACH' : 'USER'}: ${m.content}`)
    .join('\n');
  return [
    'You are updating a structured user dossier from a recent chat transcript.',
    '',
    'EXTRACTION RULES (apply in order):',
    '1. Scan every USER line for durable facts: stated majors/minors, school decisions,',
    '   goals, interests, constraints, preferences, deadlines, background details.',
    '   A single mention is enough — if the user said "I want to major in X and minor',
    '   in Y", that MUST appear in the goals field of the new dossier.',
    '2. Statements late in the transcript matter just as much as early ones. Re-read',
    '   the final USER messages carefully before finishing.',
    '3. Newer statements supersede older dossier values when they conflict.',
    '4. Merge into the existing dossier. Preserve the exact schema and field order.',
    '   Keep values terse and comma-separated.',
    '5. If a field has no new info, keep its existing value unchanged.',
    '6. Use "recent:" for conversation topics that are not yet durable facts. Move',
    '   stale recent items into stable sections (interests, goals) or drop them.',
    '7. If the total dossier would exceed ~500 tokens, compress redundant items.',
    '',
    'SELF-CHECK before output: list (mentally) each durable fact stated by the USER',
    'in the transcript, and verify each one appears somewhere in your output dossier.',
    'Losing a user-stated fact is the worst possible failure.',
    '',
    `Output ONLY the new dossier text, starting with "${DOSSIER_VERSION_MARKER}".`,
    'No markdown fences, no commentary.',
    '',
    '<current_dossier>',
    currentDossier,
    '</current_dossier>',
    '',
    '<recent_transcript>',
    transcriptText,
    '</recent_transcript>',
  ].join('\n');
}

// Detect "update the dossier" style commands. Deliberately permissive:
// catches "update my dossier", "please update the dossier now", "refresh
// dossier", "save that to my dossier", etc.
function isManualDossierCommand(message) {
  const m = message.toLowerCase();
  return /\b(update|refresh|save|sync|regenerate)\b[^.!?]{0,40}\bdossier\b/.test(m)
    || /\bdossier\b[^.!?]{0,30}\b(update|refresh|save)\b/.test(m);
}

async function updateDossierFromTranscript(userId, currentDossier, transcript) {
  // The dossier update is a single one-shot user message to Gemini; we put
  // the schema + dossier + transcript all in that one message and read back
  // the new dossier text. Lower temperature for determinism.
  const newDossier = await callGemini({
    systemInstruction:
      'You are a precise data-merger. Follow the user instructions exactly and output only the requested dossier text.',
    contents: [
      {
        role: 'user',
        parts: [{ text: dossierUpdatePrompt(currentDossier, transcript) }],
      },
    ],
    temperature: 0.2,
  });

  // Strip any accidental code fences the model might add despite instructions.
  const cleaned = newDossier
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```\s*$/, '')
    .trim();

  if (!isValidDossier(cleaned)) {
    console.warn('Dossier update produced invalid output; keeping previous dossier.');
    return { updated: false, dossier: currentDossier };
  }
  const saved = await saveDossier(userId, cleaned);
  return { updated: true, dossier: saved };
}

exports.handler = async (event) => {
  connectBlobs(event);
  const origin = originFromEnv();
  const pre = preflight(event, origin);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' }, origin);
  }

  if (!GEMINI_API_KEY) {
    return json(
      500,
      {
        error:
          'AI service is not configured. The site owner needs to set GEMINI_API_KEY in Netlify → Site settings → Environment variables.',
      },
      origin,
    );
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' }, origin);
  }

  const userId = normalizeEmail(payload.userId);
  const userMessage = String(payload.message || '').trim();

  if (!isValidEmail(userId)) {
    return json(400, { error: 'Missing or invalid userId.' }, origin);
  }
  if (!userMessage) {
    return json(400, { error: 'Message cannot be empty.' }, origin);
  }
  if (userMessage.length > MAX_MESSAGE_CHARS) {
    return json(
      400,
      { error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` },
      origin,
    );
  }

  try {
    // 1. Load dossier (auto-create an empty seed if a user somehow chats
    //    before calling /account — keeps the endpoint robust).
    let dossier = await loadDossier(userId);
    if (!dossier) {
      dossier = buildSeedDossier({});
      await saveDossier(userId, dossier);
    }

    // 2. Load chat state.
    const chat = await loadChat(userId);

    // 2a. Manual dossier update command ("update the dossier" etc.):
    //     refresh the dossier from the transcript-so-far WITHOUT resetting
    //     the conversation or consuming an exchange.
    if (isManualDossierCommand(userMessage)) {
      const transcript = chat.messages.concat([{ role: 'user', content: userMessage }]);
      let updated = false;
      if (chat.messages.length > 0) {
        const result = await updateDossierFromTranscript(userId, dossier, transcript);
        updated = result.updated;
      }
      const reply = updated
        ? 'Done — I updated your dossier with what we covered. You can review it in Settings (gear icon).'
        : chat.messages.length === 0
          ? "There's nothing new to add yet — we haven't discussed anything this conversation. Your dossier is unchanged."
          : "I tried to update the dossier but the result didn't validate, so I kept the previous version. Try again in a moment.";
      // Don't store this exchange — it's a meta-command, not conversation.
      return json(
        200,
        { reply, exchangeCount: chat.exchangeCount, dossierUpdated: updated, reset: false, manualUpdate: true },
        origin,
      );
    }

    // 3. Append user message and get the assistant reply. Web search is
    //    enabled only when the message looks like it needs live facts.
    chat.messages.push({ role: 'user', content: userMessage });
    const reply = await callGemini({
      systemInstruction: chatSystemPrompt(dossier),
      contents: toGeminiContents(chat.messages),
      temperature: 0.7,
      useSearch: needsWebSearch(userMessage),
    });

    // 4. Append reply + bump exchange count.
    chat.messages.push({ role: 'assistant', content: reply });
    chat.exchangeCount += 1;

    // 5. If we hit the reset threshold, update the dossier inline and reset.
    //    The final assistant reply is carried into the fresh conversation as
    //    context (it does NOT count as one of the next 5 exchanges).
    let dossierUpdated = false;
    if (chat.exchangeCount >= EXCHANGE_RESET_AT) {
      try {
        const result = await updateDossierFromTranscript(userId, dossier, chat.messages);
        dossierUpdated = result.updated;
      } catch (err) {
        // Don't fail the whole request if the dossier update flops — the
        // user still gets their reply. The chat still resets so memory
        // doesn't grow unbounded.
        console.error('Dossier update failed', err);
      }
      await saveChat(userId, {
        exchangeCount: 0,
        messages: [{ role: 'assistant', content: reply }],
      });
      return json(
        200,
        { reply, exchangeCount: 0, dossierUpdated, reset: true, manualUpdate: false },
        origin,
      );
    }

    // 6. Otherwise persist the new chat state and return.
    await saveChat(userId, chat);
    return json(
      200,
      { reply, exchangeCount: chat.exchangeCount, dossierUpdated: false, reset: false, manualUpdate: false },
      origin,
    );
  } catch (err) {
    console.error('chat handler failed', err && err.stack ? err.stack : err);
    const msg = err && err._userFacing
      ? err.message
      : (err && err.message) || 'Chat request failed.';
    return json(500, { error: msg }, origin);
  }
};
