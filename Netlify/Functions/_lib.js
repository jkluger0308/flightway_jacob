// Shared helpers for the AI-coach Netlify Functions (account, chat, dossier).
// ------------------------------------------------------------------------
// Keeps CORS, JSON responses, Netlify Blobs access, userId derivation,
// and the dossier seed template in one place so the per-endpoint files
// stay short and consistent.

const { getStore } = require('@netlify/blobs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Dossier schema version. Bump when the layout changes so old dossiers can
// be detected/migrated. Validation also requires the first line of any saved
// dossier to start with this exact marker.
const DOSSIER_VERSION_MARKER = '# user dossier v1';

// Cap the dossier roughly so token cost stays flat regardless of how long
// a user keeps chatting. The update prompt also tells the model to compress
// when over this limit; this is a defensive truncation on top.
const DOSSIER_MAX_CHARS = 4000;

// Reset the chat after this many full user/assistant exchanges.
const EXCHANGE_RESET_AT = 5;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function originFromEnv() {
  return process.env.ALLOWED_ORIGIN || '*';
}

function json(status, body, origin) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
    body: JSON.stringify(body),
  };
}

function preflight(event, origin) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin), body: '' };
  }
  return null;
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

// userId == email (lowercased). Per the design doc this is acceptable for
// MVP. Swap for a verified-user id when real auth is added; nothing else
// has to change.
function userIdFromEmail(email) {
  return normalizeEmail(email);
}

// Netlify Blobs stores. We use two logical stores so keys can't collide
// even if one schema changes shape later.
function dossierStore() {
  return getStore({ name: 'coach-dossiers', consistency: 'strong' });
}

function chatStore() {
  return getStore({ name: 'coach-chats', consistency: 'strong' });
}

// Returns the dossier text for a user, or null if none exists yet.
async function loadDossier(userId) {
  const store = dossierStore();
  const text = await store.get(userId);
  return text || null;
}

async function saveDossier(userId, text) {
  if (typeof text !== 'string') throw new Error('Dossier must be a string.');
  const trimmed = text.slice(0, DOSSIER_MAX_CHARS);
  await dossierStore().set(userId, trimmed);
  return trimmed;
}

// Chat blob shape: { exchangeCount: 0..EXCHANGE_RESET_AT, messages: [{role,content}] }
async function loadChat(userId) {
  const raw = await chatStore().get(userId);
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

async function saveChat(userId, state) {
  await chatStore().set(userId, JSON.stringify(state));
}

async function resetChat(userId) {
  await chatStore().set(userId, JSON.stringify({ exchangeCount: 0, messages: [] }));
}

// Build the initial dossier text from quiz results. Pure string templating —
// no LLM call. Keeps the schema fields stable so the update prompt has a
// reliable structure to merge into.
function buildSeedDossier(quizResults) {
  const q = quizResults || {};
  const list = (arr) => Array.isArray(arr) && arr.length ? arr.join(', ') : '(unknown)';
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

function isValidDossier(text) {
  if (typeof text !== 'string') return false;
  if (!text.startsWith(DOSSIER_VERSION_MARKER)) return false;
  // Require a few core keys so a totally-malformed model output is rejected.
  const required = ['top_industries:', 'interests:', 'goals:', 'recent:'];
  return required.every((k) => text.includes(k));
}

module.exports = {
  EMAIL_RE,
  DOSSIER_VERSION_MARKER,
  DOSSIER_MAX_CHARS,
  EXCHANGE_RESET_AT,
  cors,
  json,
  originFromEnv,
  preflight,
  normalizeEmail,
  isValidEmail,
  userIdFromEmail,
  loadDossier,
  saveDossier,
  loadChat,
  saveChat,
  resetChat,
  buildSeedDossier,
  isValidDossier,
};
