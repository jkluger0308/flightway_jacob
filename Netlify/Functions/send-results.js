// Netlify Function: send-results
// ---------------------------------
// Receives { email, results_url, token } from the quiz front-end and
// emails the user a link to their personalized results.
//
// Email delivery uses Resend (https://resend.com) — set the following
// environment variables in Netlify (Site settings → Environment variables):
//
//   RESEND_API_KEY    your Resend API key (starts with "re_…")
//   FROM_EMAIL        the verified sender, e.g. "DreamForce <quiz@yourdomain.com>"
//                     (during dev you can use "onboarding@resend.dev")
//   ALLOWED_ORIGIN    (optional) your site origin for CORS, e.g.
//                     "https://your-site.netlify.app". Defaults to "*".
//
// No DB. The full quiz state is encoded in the results_url hash, so this
// function only needs to send the email.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Minimal email validator — same shape as the client check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(status, body, origin) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
    body: JSON.stringify(body),
  };
}

// Escape user-controllable strings before embedding in HTML.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml(resultsUrl) {
  const safeUrl = esc(resultsUrl);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;box-shadow:0 6px 24px rgba(15,23,42,0.06);overflow:hidden;">
          <tr><td style="padding:36px 40px 0;text-align:center;">
            <div style="font-size:12px;letter-spacing:3px;font-weight:700;color:#1a56db;text-transform:uppercase;margin-bottom:10px;">DreamForce Career Compass</div>
            <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#0f172a;margin:0 0 14px;line-height:1.2;">Your results from your career quiz are ready</h1>
            <p style="font-size:15px;line-height:1.65;color:#475569;margin:0 0 28px;">
              Thanks for completing the Career Compass quiz. We scored your answers
              across 12 industries and built a personalized breakdown — top matches,
              recommended majors, classes to try, and salary outlook.
            </p>
          </td></tr>
          <tr><td align="center" style="padding:0 40px 32px;">
            <a href="${safeUrl}"
               style="display:inline-block;padding:15px 36px;background:#1a56db;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;border-radius:100px;box-shadow:0 4px 14px rgba(26,86,219,0.35);">
              View My Results →
            </a>
          </td></tr>
          <tr><td style="padding:0 40px 36px;">
            <p style="font-size:12px;line-height:1.6;color:#94a3b8;margin:0;text-align:center;">
              Button not working? Copy &amp; paste this URL into your browser:<br>
              <span style="color:#475569;word-break:break-all;">${safeUrl}</span>
            </p>
          </td></tr>
          <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;">
            <p style="font-size:11px;color:#94a3b8;margin:0;">
              You're receiving this because you requested your results at DreamForce.
              If this wasn't you, you can safely ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function buildText(resultsUrl) {
  return [
    'Your results from your career quiz are ready.',
    '',
    'Thanks for completing the DreamForce Career Compass quiz. Click the link',
    'below to view your personalized results:',
    '',
    resultsUrl,
    '',
    "If this wasn't you, you can safely ignore this email.",
  ].join('\n');
}

exports.handler = async (event) => {
  const origin = process.env.ALLOWED_ORIGIN || '*';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' }, origin);
  }

  const email = (payload.email || '').trim().toLowerCase();
  const resultsUrl = (payload.results_url || '').trim();

  if (!EMAIL_RE.test(email)) {
    return json(400, { error: 'Please provide a valid email address.' }, origin);
  }
  // Only allow http(s) URLs to prevent the email becoming an open redirect to javascript: etc.
  if (!/^https?:\/\//i.test(resultsUrl) || resultsUrl.length > 8000) {
    return json(400, { error: 'Invalid results URL.' }, origin);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.FROM_EMAIL || 'DreamForce <onboarding@resend.dev>';
  if (!apiKey) {
    console.error('RESEND_API_KEY is not configured');
    return json(500, { error: 'Email service is not configured.' }, origin);
  }

  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: 'Your results from your career quiz are ready',
        html: buildHtml(resultsUrl),
        text: buildText(resultsUrl),
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('Resend API error', resp.status, detail);
      return json(502, { error: 'Email service returned an error.' }, origin);
    }

    return json(200, { ok: true }, origin);
  } catch (err) {
    console.error('send-results failed', err);
    return json(500, { error: 'Could not send email. Please try again.' }, origin);
  }
};
