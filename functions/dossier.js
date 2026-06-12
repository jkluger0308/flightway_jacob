import {
  jsonResponse,
  preflightResponse,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  loadDossier,
  saveDossier,
  isValidDossier,
} from './_lib.js';

export async function onRequestOptions(context) {
  return preflightResponse(originFromEnv(context.env));
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = originFromEnv(env);

  if (request.method === 'OPTIONS') {
    return preflightResponse(origin);
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const email = normalizeEmail(url.searchParams.get('userId'));
    if (!isValidEmail(email)) {
      return jsonResponse(400, { error: 'Missing or invalid userId.' }, origin);
    }
    try {
      const dossier = await loadDossier(env, email);
      if (!dossier) return jsonResponse(404, { error: 'No dossier for this user yet.' }, origin);
      return jsonResponse(200, { dossier }, origin);
    } catch (err) {
      console.error('dossier GET failed', err && err.stack ? err.stack : err);
      const msg = err && err._userFacing
        ? err.message
        : `Could not load dossier: ${(err && err.message) || 'unknown server error'}.`;
      return jsonResponse(500, { error: msg }, origin);
    }
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' }, origin);
    }
    const email = normalizeEmail(payload.userId);
    const text = typeof payload.dossier === 'string' ? payload.dossier : '';
    if (!isValidEmail(email)) {
      return jsonResponse(400, { error: 'Missing or invalid userId.' }, origin);
    }
    if (!isValidDossier(text)) {
      return jsonResponse(
        400,
        {
          error:
            'Dossier must start with "# user dossier v1" and include the standard fields (top_industries, interests, goals, recent).',
        },
        origin,
      );
    }
    try {
      const saved = await saveDossier(env, email, text);
      return jsonResponse(200, { ok: true, dossier: saved }, origin);
    } catch (err) {
      console.error('dossier PUT failed', err && err.stack ? err.stack : err);
      const msg = err && err._userFacing
        ? err.message
        : `Could not save dossier: ${(err && err.message) || 'unknown server error'}.`;
      return jsonResponse(500, { error: msg }, origin);
    }
  }

  return jsonResponse(405, { error: 'Method not allowed' }, origin);
}
