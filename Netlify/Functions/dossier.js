// Netlify Function: dossier
// -------------------------
// Read or overwrite a user's dossier from the settings panel.
//
//   GET  /.netlify/functions/dossier?userId=you@example.com
//        → { dossier }
//
//   PUT  /.netlify/functions/dossier
//        body: { userId, dossier }
//        → { ok: true, dossier }
//
// User edits go straight to storage — no model call, no validation beyond
// "must include the version marker" so we don't accept random pasted text.

const {
  json,
  preflight,
  originFromEnv,
  normalizeEmail,
  isValidEmail,
  loadDossier,
  saveDossier,
  isValidDossier,
} = require('./_lib');

exports.handler = async (event) => {
  const origin = originFromEnv();
  const pre = preflight(event, origin);
  if (pre) return pre;

  if (event.httpMethod === 'GET') {
    const email = normalizeEmail((event.queryStringParameters || {}).userId);
    if (!isValidEmail(email)) {
      return json(400, { error: 'Missing or invalid userId.' }, origin);
    }
    try {
      const dossier = await loadDossier(email);
      if (!dossier) return json(404, { error: 'No dossier for this user yet.' }, origin);
      return json(200, { dossier }, origin);
    } catch (err) {
      console.error('dossier GET failed', err);
      return json(500, { error: 'Could not load dossier.' }, origin);
    }
  }

  if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' }, origin);
    }
    const email = normalizeEmail(payload.userId);
    const text = typeof payload.dossier === 'string' ? payload.dossier : '';
    if (!isValidEmail(email)) {
      return json(400, { error: 'Missing or invalid userId.' }, origin);
    }
    if (!isValidDossier(text)) {
      return json(
        400,
        {
          error:
            'Dossier must start with "# user dossier v1" and include the standard fields (top_industries, interests, goals, recent).',
        },
        origin,
      );
    }
    try {
      const saved = await saveDossier(email, text);
      return json(200, { ok: true, dossier: saved }, origin);
    } catch (err) {
      console.error('dossier PUT failed', err);
      return json(500, { error: 'Could not save dossier.' }, origin);
    }
  }

  return json(405, { error: 'Method not allowed' }, origin);
};
