import {
  jsonResponse,
  preflightResponse,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  userIdFromEmail,
  loadDossier,
  saveDossier,
  buildSeedDossier,
} from './_lib.js';

export async function onRequestOptions(context) {
  return preflightResponse(originFromEnv(context.env));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = originFromEnv(env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
  }

  const email = normalizeEmail(payload.email);
  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: 'Please provide a valid email address.' }, origin);
  }

  const userId = userIdFromEmail(email);

  try {
    const existing = await loadDossier(env, userId);
    if (existing) {
      return jsonResponse(200, { userId, alreadyExists: true }, origin);
    }
    const seed = buildSeedDossier(payload.quizResults || {});
    await saveDossier(env, userId, seed);
    return jsonResponse(200, { userId, alreadyExists: false }, origin);
  } catch (err) {
    console.error('account create failed', err && err.stack ? err.stack : err);
    const msg = err && err._userFacing
      ? err.message
      : `Could not create account: ${(err && err.message) || 'unknown server error'}.`;
    return jsonResponse(500, { error: msg }, origin);
  }
}
