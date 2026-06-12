import {
  jsonResponse,
  preflightResponse,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  loadDossier,
  saveDossier,
  loadChat,
  saveChat,
  buildSeedDossier,
  isValidDossier,
  EXCHANGE_RESET_AT,
  DOSSIER_VERSION_MARKER,
} from './_lib.js';

const MAX_MESSAGE_CHARS = 2000;

function geminiConfig(env) {
  return {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    fallbackModel: env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash',
    useSearchMode: (env.GEMINI_USE_SEARCH || 'auto').toLowerCase(),
  };
}

function geminiUrl(model, apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

const RETRYABLE_STATUS = new Set([500, 503]);
const RETRY_DELAYS_MS = [800, 2000];

function needsWebSearch(message, useSearchMode) {
  if (useSearchMode === 'always') return true;
  if (useSearchMode === 'never') return false;
  const m = String(message || '').toLowerCase();
  return (
    /\b(deadline|application|apply|tuition|salary|requirements|catalog|course list|look up|search for|find out|current|latest|website|how much|when is|what (are|is) the)\b/.test(
      m,
    )
    || /\b(major|minor|program|internship|recruiting)\b.{0,40}\b(at|for)\b/.test(m)
  );
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
  if (!useSearch) {
    body.generationConfig.responseMimeType = 'text/plain';
  }
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }
  return body;
}

async function callGeminiOnce({ model, apiKey, systemInstruction, contents, temperature, useSearch }) {
  const body = buildGeminiBody({ systemInstruction, contents, temperature, useSearch });
  const resp = await fetch(geminiUrl(model, apiKey), {
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

async function callGeminiWithRetries(opts) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await callGeminiOnce(opts);
    } catch (err) {
      lastErr = err;
      if (err.status === 429) throw err;
      if (!RETRYABLE_STATUS.has(err.status)) throw err;
    }
  }
  throw lastErr || new Error('Gemini request failed.');
}

async function callGemini(env, { systemInstruction, contents, temperature = 0.7, useSearch = false }) {
  const { apiKey, model, fallbackModel } = geminiConfig(env);
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Cloudflare Pages → Settings → Variables and Secrets, then redeploy.',
    );
  }

  const attempts = [{ model, useSearch }];
  if (fallbackModel && fallbackModel !== model) {
    attempts.push({ model: fallbackModel, useSearch: false });
  }

  let lastStatus = null;
  for (const { model: m, useSearch: search } of attempts) {
    try {
      return await callGeminiWithRetries({
        model: m,
        apiKey,
        systemInstruction,
        contents,
        temperature,
        useSearch: search,
      });
    } catch (err) {
      lastStatus = err.status || lastStatus;
      if (err.status !== 429 && err.status !== 503) throw err;
      console.warn(`Gemini [${m}] failed (${err.status}), trying next option…`);
    }
  }

  const friendly = lastStatus === 429
    ? 'Google rate-limited this API key (free tier: ~15–30 requests/min). '
      + 'Wait 60 seconds and try again. If this happens on your very first message, '
      + 'open aistudio.google.com → your project → check that the API has quota (billing '
      + 'may need to be linked even for free usage). You can also set GEMINI_MODEL=gemini-2.5-flash-lite in Cloudflare env vars.'
    : lastStatus === 503
      ? "Google's AI service is briefly overloaded. Your message wasn't lost — try again in a few seconds."
      : 'The AI service is temporarily unavailable. Please try again.';
  const e = new Error(friendly);
  e._userFacing = true;
  throw e;
}

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

function isManualDossierCommand(message) {
  const m = message.toLowerCase();
  return (
    /\b(update|refresh|save|sync|regenerate)\b[^.!?]{0,40}\bdossier\b/.test(m)
    || /\bdossier\b[^.!?]{0,30}\b(update|refresh|save)\b/.test(m)
  );
}

async function updateDossierFromTranscript(env, userId, currentDossier, transcript) {
  const newDossier = await callGemini(env, {
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

  const cleaned = newDossier
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```\s*$/, '')
    .trim();

  if (!isValidDossier(cleaned)) {
    console.warn('Dossier update produced invalid output; keeping previous dossier.');
    return { updated: false, dossier: currentDossier };
  }
  const saved = await saveDossier(env, userId, cleaned);
  return { updated: true, dossier: saved };
}

export async function onRequestOptions(context) {
  return preflightResponse(originFromEnv(context.env));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = originFromEnv(env);
  const { apiKey, useSearchMode } = geminiConfig(env);

  if (!apiKey) {
    return jsonResponse(
      500,
      {
        error:
          'AI service is not configured. Set GEMINI_API_KEY in Cloudflare Pages → Settings → Variables and Secrets.',
      },
      origin,
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
  }

  const userId = normalizeEmail(payload.userId);
  const userMessage = String(payload.message || '').trim();

  if (!isValidEmail(userId)) {
    return jsonResponse(400, { error: 'Missing or invalid userId.' }, origin);
  }
  if (!userMessage) {
    return jsonResponse(400, { error: 'Message cannot be empty.' }, origin);
  }
  if (userMessage.length > MAX_MESSAGE_CHARS) {
    return jsonResponse(
      400,
      { error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).` },
      origin,
    );
  }

  try {
    let dossier = await loadDossier(env, userId);
    if (!dossier) {
      dossier = buildSeedDossier({});
      await saveDossier(env, userId, dossier);
    }

    const chat = await loadChat(env, userId);

    if (isManualDossierCommand(userMessage)) {
      const transcript = chat.messages.concat([{ role: 'user', content: userMessage }]);
      let updated = false;
      if (chat.messages.length > 0) {
        const result = await updateDossierFromTranscript(env, userId, dossier, transcript);
        updated = result.updated;
      }
      const reply = updated
        ? 'Done — I updated your dossier with what we covered. You can review it in Settings (gear icon).'
        : chat.messages.length === 0
          ? "There's nothing new to add yet — we haven't discussed anything this conversation. Your dossier is unchanged."
          : "I tried to update the dossier but the result didn't validate, so I kept the previous version. Try again in a moment.";
      return jsonResponse(
        200,
        { reply, exchangeCount: chat.exchangeCount, dossierUpdated: updated, reset: false, manualUpdate: true },
        origin,
      );
    }

    chat.messages.push({ role: 'user', content: userMessage });
    const reply = await callGemini(env, {
      systemInstruction: chatSystemPrompt(dossier),
      contents: toGeminiContents(chat.messages),
      temperature: 0.7,
      useSearch: needsWebSearch(userMessage, useSearchMode),
    });

    chat.messages.push({ role: 'assistant', content: reply });
    chat.exchangeCount += 1;

    let dossierUpdated = false;
    if (chat.exchangeCount >= EXCHANGE_RESET_AT) {
      try {
        const result = await updateDossierFromTranscript(env, userId, dossier, chat.messages);
        dossierUpdated = result.updated;
      } catch (err) {
        console.error('Dossier update failed', err);
      }
      await saveChat(env, userId, {
        exchangeCount: 0,
        messages: [{ role: 'assistant', content: reply }],
      });
      return jsonResponse(
        200,
        { reply, exchangeCount: 0, dossierUpdated, reset: true, manualUpdate: false },
        origin,
      );
    }

    await saveChat(env, userId, chat);
    return jsonResponse(
      200,
      { reply, exchangeCount: chat.exchangeCount, dossierUpdated: false, reset: false, manualUpdate: false },
      origin,
    );
  } catch (err) {
    console.error('chat handler failed', err && err.stack ? err.stack : err);
    const msg = err && err._userFacing
      ? err.message
      : (err && err.message) || 'Chat request failed.';
    return jsonResponse(500, { error: msg }, origin);
  }
}
