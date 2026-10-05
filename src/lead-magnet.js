// Email-list lead magnet: "The Dealer Email Scripts".
//
// POST /api/guide-signup  { email, source, company }
//   1. Adds/updates the contact in Brevo, on the "Guide downloaders" list,
//      with SIGNUP_SOURCE set to the form's source tag (e.g.
//      "negotiation-guide") so that segment can be mailed separately later.
//   2. Sends the welcome email with the PDF attached, as a Brevo
//      transactional send.
//
// Why the welcome email is sent from here rather than by a Brevo automation:
// Brevo automation/marketing emails can't carry file attachments, and the
// PDF *is* the deliverable. The contact still lands on the list, so any later
// automation or campaign (e.g. the Deal Review launch) works off that list.
//
// Configuration (Worker secrets — `npx wrangler secret put <NAME>`):
//   BREVO_API_KEY         Brevo API key (same account dealer-api uses).
//   BREVO_GUIDE_LIST_ID   Numeric id of the "Guide downloaders" list.
// Until BOTH are set, leadMagnetEnabled() is false: the capture block is
// stripped from the page (src/index.js) and this endpoint answers 503, so a
// half-configured deploy never shows a form that can't deliver.

const PDF_PATH = '/downloads/dealer-email-scripts.pdf';
const PDF_NAME = 'The-Dealer-Email-Scripts.pdf';
// Same Brevo-verified sender dealer-api already uses; replies land in the
// inbox Jeff monitors.
const SENDER = { email: 'theexactmatch@gmail.com', name: 'Jeff at The Exact Match' };

// Every source tag the endpoint accepts. A form posting anything else is
// rejected rather than silently creating a new, unplanned segment.
const SOURCES = new Set(['negotiation-guide']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const leadMagnetEnabled = (env) => Boolean(env.BREVO_API_KEY && env.BREVO_GUIDE_LIST_ID);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function brevo(env, path, body) {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify(body),
  });
  const text = res.ok ? '' : await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

// Creates the contact, or updates it if it already exists (updateEnabled).
// If the SIGNUP_SOURCE attribute hasn't been created in Brevo yet, Brevo
// rejects the whole call — retry without attributes so a missing attribute
// costs us the source tag, not the subscriber.
async function upsertContact(env, email, source) {
  const base = { email, listIds: [Number(env.BREVO_GUIDE_LIST_ID)], updateEnabled: true };
  let r = await brevo(env, '/contacts', { ...base, attributes: { SIGNUP_SOURCE: source } });
  if (!r.ok && r.status === 400 && /attribute/i.test(r.text)) {
    console.error('[lead-magnet] SIGNUP_SOURCE attribute missing in Brevo; adding contact without it', r.text);
    r = await brevo(env, '/contacts', base);
  }
  if (!r.ok) console.error('[lead-magnet] Brevo contact upsert failed', r.status, r.text);
  return r.ok;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const P = 'style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2b2b2b"';
const WELCOME_HTML = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">
  <p ${P}>You're in. The scripts are attached — first email, follow-up, and exactly what to say when the dealer calls instead of replying.</p>
  <p ${P}>The one thing most people skip: get the final number <strong>in writing before you visit</strong>, then check the buyer's order line by line at signing. That's where the add-ons sneak back in.</p>
  <p ${P}>If you're mid-deal and want me to look over your numbers before you sign, that's what <a href="https://theexactmatch.com/deal-review" style="color:#0f1f35">Deal Review</a> is for — $49.99, and it's credited toward White Glove if you want the whole deal handled.</p>
  <p style="margin:0;font-size:16px;line-height:1.6;color:#2b2b2b">— Jeff<br/>The Exact Match</p>
  <p style="margin:28px 0 0;font-size:12px;color:#888">You're getting this because you asked for the dealer email scripts at <a href="https://theexactmatch.com/advice/how-to-negotiate-car-price" style="color:#888">theexactmatch.com</a>.</p>
</div>`;

async function sendWelcome(env, origin, email, source) {
  const pdf = await env.ASSETS.fetch(new Request(`${origin}${PDF_PATH}`));
  if (!pdf.ok) {
    console.error('[lead-magnet] PDF asset missing', pdf.status);
    return false;
  }
  const r = await brevo(env, '/smtp/email', {
    sender: SENDER,
    replyTo: SENDER,
    to: [{ email }],
    subject: 'Your dealer email scripts (+ the one thing most people skip)',
    htmlContent: WELCOME_HTML,
    attachment: [{ name: PDF_NAME, content: toBase64(await pdf.arrayBuffer()) }],
    tags: ['lead-magnet', source],
  });
  if (!r.ok) console.error('[lead-magnet] Brevo welcome send failed', r.status, r.text);
  return r.ok;
}

export async function handleGuideSignup(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!leadMagnetEnabled(env)) return json({ error: 'Signups are temporarily unavailable.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Honeypot: a hidden field real visitors never fill. Answer as if it
  // worked so the bot has nothing to learn from.
  if (body.company) return json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  const source = String(body.source || '');
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!SOURCES.has(source)) return json({ error: 'Invalid request.' }, 400);

  // Both steps always run: a list failure shouldn't stop someone getting the
  // PDF they asked for, and vice versa. Success to the visitor means the
  // email went out — that's the promise the form makes.
  const [, sent] = await Promise.all([
    upsertContact(env, email, source),
    sendWelcome(env, url.origin, email, source),
  ]);
  if (!sent) return json({ error: "Something went wrong sending the scripts. Please try again, or text us at (512) 650-9328." }, 502);
  return json({ ok: true });
}
