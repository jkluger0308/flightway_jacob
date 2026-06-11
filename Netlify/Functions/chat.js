// Netlify Function: chat
// ----------------------
// One endpoint for the AI career coach. Holds the 5-exchange counter
// server-side and triggers an inline dossier update + chat wipe when the
// counter hits the reset point.
//
// Request:
//   POST /.netlify/functions/chat
//   { userId: "you@example.com", message: "..." }
//
// Response:
//   { reply, exchangeCount, dossierUpdated }
//
// Environment variables (set in Netlify Site settings → Environment variables):
//   GEMINI_API_KEY   required. Get one free at https://aistudio.google.com/.
//   GEMINI_MODEL     optional, defaults to "gemini-2.5-flash".
//   ALLOWED_ORIGIN   optional, defaults to "*".

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
} = require('./_lib');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

async function callGemini({ systemInstruction, contents, temperature = 0.7 }) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Netlify Site settings → Environment variables and redeploy.',
    );
  }
  const resp = await fetch(geminiUrl(GEMINI_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: 800,
        responseMimeType: 'text/plain',
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    console.error('Gemini API error', resp.status, detail);
    throw new Error(`Gemini API returned ${resp.status}.`);
  }
  const data = await resp.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim() || '';
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }
  return text;
}

function chatSystemPrompt(dossier) {
  return [
    'You are Flightway Coach, an AI career coach for high school students.',
    'Speak directly and concretely. Avoid generic advice. Use the user dossier',
    'below as their persistent profile — never ask them for info that is',
    "already in the dossier. Keep replies tight (under ~150 words) unless the",
    'user explicitly asks for depth. Suggest specific next actions when useful.',
    '',
    '<user_dossier>',
    dossier,
    '</user_dossier>',
  ].join('\n');
}

function dossierUpdatePrompt(currentDossier, transcript) {
  const transcriptText = transcript
    .map((m) => `${m.role === 'assistant' ? 'COACH' : 'USER'}: ${m.content}`)
    .join('\n');
  return [
    'You are updating a structured user dossier from a recent chat transcript.',
    'Merge any new, durable facts about the user into the existing dossier.',
    'Preserve the exact schema and field order. Keep values terse and comma-separated.',
    'If a field is still unknown, leave its existing value. Move stale items from',
    '"recent:" into the appropriate stable section (interests, goals, etc.).',
    'If the total dossier would exceed ~500 tokens, compress redundant items.',
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

    // 2. Load chat state, append new user message.
    const chat = await loadChat(userId);
    chat.messages.push({ role: 'user', content: userMessage });

    // 3. Get the assistant reply.
    const reply = await callGemini({
      systemInstruction: chatSystemPrompt(dossier),
      contents: toGeminiContents(chat.messages),
      temperature: 0.7,
    });

    // 4. Append reply + bump exchange count.
    chat.messages.push({ role: 'assistant', content: reply });
    chat.exchangeCount += 1;

    // 5. If we hit the reset threshold, update the dossier inline and wipe.
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
      await resetChat(userId);
      return json(
        200,
        { reply, exchangeCount: EXCHANGE_RESET_AT, dossierUpdated },
        origin,
      );
    }

    // 6. Otherwise persist the new chat state and return.
    await saveChat(userId, chat);
    return json(
      200,
      { reply, exchangeCount: chat.exchangeCount, dossierUpdated: false },
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
