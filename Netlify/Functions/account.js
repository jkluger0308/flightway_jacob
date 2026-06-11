// Netlify Function: account
// -------------------------
// Creates (or restores) a coach "account" keyed by email.
//
// Request:
//   POST /.netlify/functions/account
//   { email: "you@example.com",
//     quizResults?: { topIndustries, archetype, recommendedMajors,
//                     school, gpa, strengths, weaknesses } }
//
// Response:
//   { userId, alreadyExists }
//
// On first call for an email we save a seed dossier built from the quiz
// results. Returning users keep their existing dossier untouched.

const {
  json,
  preflight,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  userIdFromEmail,
  loadDossier,
  saveDossier,
  buildSeedDossier,
  connectBlobs,
} = require('./_lib');

exports.handler = async (event) => {
  connectBlobs(event);
  const origin = originFromEnv();
  const pre = preflight(event, origin);
  if (pre) return pre;
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' }, origin);
  }

  const email = normalizeEmail(payload.email);
  if (!isValidEmail(email)) {
    return json(400, { error: 'Please provide a valid email address.' }, origin);
  }

  const userId = userIdFromEmail(email);

  try {
    const existing = await loadDossier(userId);
    if (existing) {
      return json(200, { userId, alreadyExists: true }, origin);
    }
    const seed = buildSeedDossier(payload.quizResults || {});
    await saveDossier(userId, seed);
    return json(200, { userId, alreadyExists: false }, origin);
  } catch (err) {
    console.error('account create failed', err && err.stack ? err.stack : err);
    // Surface the underlying error message so the user (and the dev console)
    // can see what actually went wrong. _userFacing errors come from _lib.js
    // and are safe to show as-is; everything else gets a generic prefix.
    const msg = err && err._userFacing
      ? err.message
      : `Could not create account: ${(err && err.message) || 'unknown server error'}.`;
    return json(500, { error: msg }, origin);
  }
};
