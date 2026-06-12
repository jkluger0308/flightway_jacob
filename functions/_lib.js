// Shared helpers for the AI-coach Cloudflare Pages Functions.
// Uses Workers KV (binding: COACH_KV) instead of Netlify Blobs.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const DOSSIER_VERSION_MARKER = '# user dossier v1';
export const DOSSIER_MAX_CHARS = 4000;
export const EXCHANGE_RESET_AT = 5;

const DOSSIER_PREFIX = 'dossier:';
const CHAT_PREFIX = 'chat:';

export function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function originFromEnv(env) {
  return env.ALLOWED_ORIGIN || '*';
}

export function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}

export function preflightResponse(origin) {
  return new Response(null, { status: 204, headers: cors(origin) });
}

export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

export function userIdFromEmail(email) {
  return normalizeEmail(email);
}

function requireKv(env) {
  if (!env.COACH_KV) {
    const e = new Error(
      'COACH_KV is not bound. Create a KV namespace in Cloudflare, bind it as COACH_KV in Pages → Settings → Functions → KV namespace bindings, then redeploy.',
    );
    e._userFacing = true;
    throw e;
  }
  return env.COACH_KV;
}

export async function loadDossier(env, userId) {
  const text = await requireKv(env).get(DOSSIER_PREFIX + userId);
  return text || null;
}

export async function saveDossier(env, userId, text) {
  if (typeof text !== 'string') throw new Error('Dossier must be a string.');
  const trimmed = text.slice(0, DOSSIER_MAX_CHARS);
  await requireKv(env).put(DOSSIER_PREFIX + userId, trimmed);
  return trimmed;
}

export async function loadChat(env, userId) {
  const raw = await requireKv(env).get(CHAT_PREFIX + userId);
  if (!raw) return { exchangeCount: 0, messages: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { exchangeCount: 0, messages: [] };
    return {
      exchangeCount: Number.isInteger(parsed.exchangeCount) ? parsed.exchangeCount : 0,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return { exchangeCount: 0, messages: [] };
  }
}

export async function saveChat(env, userId, state) {
  await requireKv(env).put(CHAT_PREFIX + userId, JSON.stringify(state));
}

export function buildSeedDossier(quizResults) {
  const q = quizResults || {};
  const list = (arr) => (Array.isArray(arr) && arr.length ? arr.join(', ') : '(unknown)');
  const single = (v) => (v === null || v === undefined || v === '' ? '(unknown)' : String(v));

  return [
    DOSSIER_VERSION_MARKER,
    `top_industries: ${list(q.topIndustries)}`,
    `archetype: ${single(q.archetype)}`,
    `recommended_majors: ${list(q.recommendedMajors)}`,
    `school: ${single(q.school)}`,
    `gpa: ${single(q.gpa)}`,
    `quiz_strengths: ${list(q.strengths)}`,
    `quiz_weaknesses: ${list(q.weaknesses)}`,
    `interests: (none yet)`,
    `goals: (none yet)`,
    `constraints: (none yet)`,
    `context: seeded from career quiz results`,
    `recent: (no chat yet)`,
    `notes: (none yet)`,
  ].join('\n');
}

export function isValidDossier(text) {
  if (typeof text !== 'string') return false;
  if (!text.startsWith(DOSSIER_VERSION_MARKER)) return false;
  const required = ['top_industries:', 'interests:', 'goals:', 'recent:'];
  return required.every((k) => text.includes(k));
}
