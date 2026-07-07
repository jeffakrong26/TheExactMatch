// ── TheExactMatch Dealer Portal API ──────────────────────────────
// Cloudflare Worker + D1 (dealer-portal database). Bearer-token sessions,
// PBKDF2 password hashing.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_SUB_STATUSES    = ['pending', 'approved', 'rejected', 'published'];
const VALID_DEALER_STATUSES = ['active', 'suspended'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Crypto helpers ────────────────────────────────────────────────
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function randomHex(byteLen) {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

// ── Router ────────────────────────────────────────────────────────
function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts    = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = pathParts[i];
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

async function authenticate(token, env) {
  return env.DB.prepare(
    `SELECT dealers.* FROM dealer_sessions JOIN dealers ON dealers.id = dealer_sessions.dealer_id
     WHERE dealer_sessions.id = ? AND dealer_sessions.expires_at > datetime('now')`
  ).bind(token).first();
}

// ── Setup (one-time bootstrap) ───────────────────────────────────
async function initAdmin(request, env) {
  const { count } = await env.DB.prepare('SELECT COUNT(*) as count FROM dealers').first();
  if (count > 0) return json({ error: 'Setup already completed.' }, 403);

  const body = await request.json().catch(() => ({}));
  const name            = (body.name || '').trim();
  const dealership_name = (body.dealership_name || 'TheExactMatch').trim();
  const email           = (body.email || '').trim().toLowerCase();
  const password        = body.password || '';

  if (!name || !email || !password) return json({ error: 'Name, email, and password are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);

  await env.DB.prepare(
    `INSERT INTO dealers (name, dealership_name, email, password_hash, password_salt, role, status)
     VALUES (?, ?, ?, ?, ?, 'admin', 'active')`
  ).bind(name, dealership_name, email, hash, salt).run();

  return json({ success: true });
}

// ── Dealer auth ───────────────────────────────────────────────────
async function dealerLogin(request, env) {
  const body     = await request.json().catch(() => ({}));
  const email    = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password) return json({ error: 'Email and password are required.' }, 400);

  const dealer = await env.DB.prepare('SELECT * FROM dealers WHERE email = ?').bind(email).first();
  if (!dealer) return json({ error: 'Invalid email or password.' }, 401);
  if (dealer.status !== 'active') return json({ error: 'This account has been suspended. Contact Jeff.' }, 403);

  const hash = await hashPassword(password, dealer.password_salt);
  if (hash !== dealer.password_hash) return json({ error: 'Invalid email or password.' }, 401);

  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO dealer_sessions (id, dealer_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`
  ).bind(token, dealer.id).run();

  return json({
    token,
    dealer: { id: dealer.id, name: dealer.name, dealership_name: dealer.dealership_name, email: dealer.email, role: dealer.role },
  });
}

async function dealerLogout(request, env, params, dealer, token) {
  await env.DB.prepare('DELETE FROM dealer_sessions WHERE id = ?').bind(token).run();
  return json({ success: true });
}

async function dealerMe(request, env, params, dealer) {
  return json({ id: dealer.id, name: dealer.name, dealership_name: dealer.dealership_name, email: dealer.email, role: dealer.role });
}

// ── Dealer actions ────────────────────────────────────────────────
async function submitVehicle(request, env, params, dealer) {
  const body = await request.json().catch(() => ({}));
  const { year, make, model, price, mileage, category, description, image_urls } = body;

  if (!year || !make || !model || !price || !mileage || !category) {
    return json({ error: 'Year, Make, Model, Price, Mileage, and Category are required.' }, 400);
  }

  const result = await env.DB.prepare(
    `INSERT INTO inventory_submissions (dealer_id, year, make, model, mileage, asking_price, category, description, image_urls, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(dealer.id, +year, make.trim(), model.trim(), +mileage, +price, category, (description || '').trim(), JSON.stringify(image_urls || [])).run();

  return json({ success: true, id: result.meta.last_row_id });
}

async function dealerLeads(request, env, params, dealer) {
  const { results } = await env.DB.prepare(
    `SELECT sell_my_car_leads.id, sell_my_car_leads.year, sell_my_car_leads.make, sell_my_car_leads.model,
       sell_my_car_leads.mileage, sell_my_car_leads.condition, sell_my_car_leads.title_status,
       sell_my_car_leads.city, sell_my_car_leads.state, sell_my_car_leads.notes, sell_my_car_leads.created_at,
       vehicle_valuations.status as valuation_status, vehicle_valuations.vin as valuation_vin,
       vehicle_valuations.final_retail_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
       vehicle_valuations.photo_confirmed,
       (SELECT url FROM valuation_photos WHERE valuation_id = vehicle_valuations.id AND slot = 'front_34' LIMIT 1) as front_photo_url,
       EXISTS(SELECT 1 FROM lead_interest WHERE lead_id = sell_my_car_leads.id AND dealer_id = ?) as i_expressed_interest
     FROM sell_my_car_leads
     LEFT JOIN vehicle_valuations ON vehicle_valuations.lead_id = sell_my_car_leads.id
     ORDER BY sell_my_car_leads.created_at DESC`
  ).bind(dealer.id).all();

  return json({ leads: results.map(l => ({ ...l, i_expressed_interest: !!l.i_expressed_interest, photo_confirmed: !!l.photo_confirmed })) });
}

async function fetchPhotosBySlot(env, valuationId) {
  const { results: photoRows } = await env.DB.prepare(
    'SELECT slot, url FROM valuation_photos WHERE valuation_id = ? ORDER BY created_at'
  ).bind(valuationId).all();

  const photosBySlot = {};
  for (const row of photoRows) (photosBySlot[row.slot] ||= []).push(row.url);
  return photosBySlot;
}

async function dealerGetLeadValuation(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*,
      sell_my_car_leads.zip, sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim,
      sell_my_car_leads.exterior_color, sell_my_car_leads.title_status
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.lead_id = ?
  `).bind(+params.id).first();
  if (!valuation) return json({ error: 'No valuation found for this lead yet.' }, 404);
  const photos = await fetchPhotosBySlot(env, valuation.id);
  return json({ valuation: { ...valuation, photo_confirmed: !!valuation.photo_confirmed }, photos });
}

async function expressInterest(request, env, params, dealer) {
  const leadId = +params.id;
  const lead = await env.DB.prepare('SELECT id FROM sell_my_car_leads WHERE id = ?').bind(leadId).first();
  if (!lead) return json({ error: 'Lead not found.' }, 404);

  await env.DB.prepare('INSERT OR IGNORE INTO lead_interest (lead_id, dealer_id) VALUES (?, ?)').bind(leadId, dealer.id).run();
  return json({ success: true });
}

async function mySubmissions(request, env, params, dealer) {
  const { results } = await env.DB.prepare(
    `SELECT id, year, make, model, mileage, asking_price AS price, category, description, status, created_at
     FROM inventory_submissions WHERE dealer_id = ? ORDER BY created_at DESC`
  ).bind(dealer.id).all();
  return json({ submissions: results });
}

// ── Admin actions ─────────────────────────────────────────────────
async function adminSubmissions(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT inventory_submissions.id, inventory_submissions.year, inventory_submissions.make, inventory_submissions.model,
            inventory_submissions.mileage, inventory_submissions.asking_price AS price, inventory_submissions.category,
            inventory_submissions.description, inventory_submissions.status, inventory_submissions.created_at,
            dealers.name as dealer_name, dealers.dealership_name
     FROM inventory_submissions JOIN dealers ON dealers.id = inventory_submissions.dealer_id
     ORDER BY inventory_submissions.created_at DESC`
  ).all();
  return json({ submissions: results });
}

async function adminUpdateSubmission(request, env, params) {
  const body = await request.json().catch(() => ({}));
  if (!VALID_SUB_STATUSES.includes(body.status)) return json({ error: 'Invalid status.' }, 400);
  await env.DB.prepare('UPDATE inventory_submissions SET status = ? WHERE id = ?').bind(body.status, +params.id).run();
  return json({ success: true });
}

async function adminLeads(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT sell_my_car_leads.*,
      COUNT(lead_interest.dealer_id) as interest_count,
      GROUP_CONCAT(dealers.dealership_name) as interested_dealers,
      vehicle_valuations.status as valuation_status,
      vehicle_valuations.vin as valuation_vin,
      vehicle_valuations.final_retail_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
      vehicle_valuations.photo_confirmed,
      (SELECT url FROM valuation_photos WHERE valuation_id = vehicle_valuations.id AND slot = 'front_34' LIMIT 1) as front_photo_url
    FROM sell_my_car_leads
    LEFT JOIN lead_interest ON lead_interest.lead_id = sell_my_car_leads.id
    LEFT JOIN dealers ON dealers.id = lead_interest.dealer_id
    LEFT JOIN vehicle_valuations ON vehicle_valuations.lead_id = sell_my_car_leads.id
    GROUP BY sell_my_car_leads.id
    ORDER BY sell_my_car_leads.created_at DESC
  `).all();
  return json({ leads: results.map(l => ({ ...l, photo_confirmed: !!l.photo_confirmed })) });
}

async function adminGetLeadValuation(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*,
      sell_my_car_leads.first_name, sell_my_car_leads.last_name, sell_my_car_leads.email, sell_my_car_leads.phone,
      sell_my_car_leads.zip, sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim,
      sell_my_car_leads.exterior_color, sell_my_car_leads.title_status
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.lead_id = ?
  `).bind(+params.id).first();
  if (!valuation) return json({ error: 'No valuation found for this lead yet.' }, 404);
  const photos = await fetchPhotosBySlot(env, valuation.id);
  return json({ valuation: { ...valuation, photo_confirmed: !!valuation.photo_confirmed }, photos });
}

async function adminFindLeads(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM find_car_leads ORDER BY created_at DESC`
  ).all();
  return json({ leads: results });
}

async function adminContactMessages(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM contact_messages ORDER BY created_at DESC`
  ).all();
  return json({ messages: results });
}

// ── Public marketing-site form submissions ───────────────────────
async function submitFindCarLead(request, env, params, dealer, token, ctx) {
  const body        = await request.json().catch(() => ({}));
  const first_name  = (body.first_name || '').trim();
  const last_name   = (body.last_name || '').trim();
  const email       = (body.email || '').trim().toLowerCase();
  const phone       = (body.phone || '').trim();

  if (!first_name || !last_name || !email) return json({ error: 'Name and email are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);

  const result = await env.DB.prepare(`
    INSERT INTO find_car_leads (
      first_name, last_name, email, phone, zip, vehicle_type, size_preference, condition,
      budget_min, budget_max, timeline, payment_method, credit_range, desired_monthly_min, desired_monthly_max, down_payment,
      priorities, current_vehicle, current_like, current_change,
      trade_in, specific_needs, considering, anything_else
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    first_name, last_name, email, phone,
    (body.zip || '').trim(), body.vehicle_type || '', body.size_preference || '', body.condition || '',
    (body.budget_min || '').toString().trim(), (body.budget_max || '').toString().trim(), body.timeline || '',
    body.payment_method || '', body.credit_range || '',
    (body.desired_monthly_min || '').toString().trim(), (body.desired_monthly_max || '').toString().trim(), (body.down_payment || '').toString().trim(),
    body.priorities || '',
    (body.current_vehicle || '').trim(), (body.current_like || '').trim(), (body.current_change || '').trim(),
    body.trade_in || '', (body.specific_needs || '').trim(), (body.considering || '').trim(), (body.anything_else || '').trim()
  ).run();

  const leadId = result.meta.last_row_id;
  if (ctx) {
    ctx.waitUntil(sendClientConfirmationEmail(env, { first_name, email }).catch(err => console.error('confirmation email failed', leadId, err)));
    ctx.waitUntil(generateReportForLead(env, leadId).catch(err => console.error('report pipeline failed for lead', leadId, err)));
  }

  return json({ success: true });
}

// ── Automated report pipeline ────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function brandedEmailHtml(innerHtml) {
  return `
  <div style="background:#F5F0E8;padding:2rem 0;font-family:Georgia,serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #DDD8CC;border-radius:4px;overflow:hidden;">
      <tr>
        <td style="background:#0C1C33;padding:1.75rem 2rem;text-align:center;">
          <span style="font-family:Georgia,serif;font-size:1.3rem;color:#ffffff;letter-spacing:.02em;">The<span style="color:#C09A5B;">Exact</span>Match</span>
        </td>
      </tr>
      <tr>
        <td style="padding:2rem;font-family:Helvetica,Arial,sans-serif;font-size:.95rem;line-height:1.7;color:#0C1C33;">
          ${innerHtml}
        </td>
      </tr>
      <tr>
        <td style="background:#EDE7D9;padding:1.25rem 2rem;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:.72rem;color:#4A5568;">
          TheExactMatch.com &middot; (512) 650-9328
        </td>
      </tr>
    </table>
  </div>`;
}

function sendClientConfirmationEmail(env, lead) {
  const html = brandedEmailHtml(`
    <p>Hey ${escapeHtml(lead.first_name)},</p>
    <p>We got your request and we're already working on finding your options. You'll hear from us within the hour.</p>
    <p>In the meantime, feel free to reply to this email with any questions.</p>
    <p>— Jeff</p>
  `);
  return sendBrevoEmail(env, {
    to: lead.email,
    subject: "We've got your request — options coming your way",
    html,
  });
}

async function sendBrevoEmail(env, { to, subject, html }) {
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: 'theexactmatch@gmail.com', name: 'TheExactMatch' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Brevo email rejected', res.status, body);
    }
  } catch (err) {
    console.error('Brevo email failed', err);
  }
}

function buildVehiclePrompt(lead) {
  const year = new Date().getFullYear();
  return `A car-buying client filled out our "Find My Car" form. Based on their answers, recommend exactly 3 specific vehicles (year, make, model, trim) that best fit their needs. For each, write a short rationale addressed DIRECTLY to the client in second person — always "you"/"your", never "they"/"their"/"the client"/"the buyer". For example: "This fits your need for extra cargo space" — not "This fits their need for extra cargo space."

Client details:
- Vehicle type: ${lead.vehicle_type || 'not specified'}
- Size preference: ${lead.size_preference || 'not specified'}
- Condition: ${lead.condition || 'not specified'}
- Budget: $${lead.budget_min || '?'} to $${lead.budget_max || '?'}
- Timeline: ${lead.timeline || 'not specified'}
- Payment method: ${lead.payment_method || 'not specified'}
${(lead.payment_method === 'Financing' || lead.payment_method === 'Leasing') ? `- Credit range: ${lead.credit_range || 'not specified'}
- Desired monthly payment: $${lead.desired_monthly_min || '?'} to $${lead.desired_monthly_max || '?'}
- Down payment available: $${lead.down_payment || 'not specified'}` : ''}
- Priorities: ${lead.priorities || 'not specified'}
- Current vehicle: ${lead.current_vehicle || 'none stated'}
- What they like about their current vehicle: ${lead.current_like || 'not specified'}
- What they want to change: ${lead.current_change || 'not specified'}
- Interested in a trade-in: ${lead.trade_in || 'not specified'}
- Specific needs/requirements: ${lead.specific_needs || 'none stated'}
- Makes/models already considering: ${lead.considering || 'none stated'}
- Anything else: ${lead.anything_else || 'none stated'}

Recommend real vehicles (roughly ${year - 3}–${year} model years) that a dealer network would realistically have in stock, fitting their stated budget range. Overall vehicle price/value is still the primary constraint, but when paying via financing or leasing, use their credit range, desired monthly payment, and down payment to judge which specific trims and model years are realistic for them.`;
}

async function pickVehicles(env, lead) {
  const tool = {
    name: 'record_recommendations',
    description: 'Record exactly 3 recommended vehicles for this buyer.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        vehicles: {
          type: 'array',
          description: 'Exactly 3 vehicle recommendations, no more and no fewer.',
          items: {
            type: 'object',
            properties: {
              year: { type: 'integer' },
              make: { type: 'string' },
              model: { type: 'string' },
              trim: { type: 'string' },
              rationale: { type: 'string', description: 'Why this fits your budget, priorities, and situation — written in second person, directly addressing the client as "you"/"your"' },
            },
            required: ['year', 'make', 'model', 'trim', 'rationale'],
            additionalProperties: false,
          },
        },
      },
      required: ['vehicles'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_recommendations' },
      messages: [{ role: 'user', content: buildVehiclePrompt(lead) }],
    }),
  });

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the recommendation request');
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block: ' + JSON.stringify(data));
  const vehicles = toolUse.input.vehicles || [];
  if (vehicles.length !== 3) throw new Error(`Expected 3 vehicles, got ${vehicles.length}: ` + JSON.stringify(vehicles));
  return vehicles;
}

const MARKETCHECK_RADII = [25, 50, 100, 200, 300];

const MARKETCHECK_MAKE_ALIASES = {
  'mercedes-amg': 'Mercedes-Benz',
  'mercedes amg': 'Mercedes-Benz',
  'amg': 'Mercedes-Benz',
  'mercedes': 'Mercedes-Benz',
  'chevy': 'Chevrolet',
};

function normalizeMakeForMarketcheck(make) {
  const key = (make || '').toLowerCase().trim();
  return MARKETCHECK_MAKE_ALIASES[key] || make;
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function trimMatches(listingTrim, recommendedTrim, listingModel, recommendedModel) {
  const lt = normalizeForMatch(listingTrim);
  const rt = normalizeForMatch(recommendedTrim);
  const lm = normalizeForMatch(listingModel);
  const rm = normalizeForMatch(recommendedModel);
  if (rt) return lt === rt || lt.includes(rt) || rt.includes(lt);
  return lm === rm;
}

async function searchMarketcheck(env, { make, model, trim, zip, year, budgetMax, throttledFetch }) {
  const yearMin = year ? Number(year) - 2 : null;
  const yearMax = year ? Number(year) + 2 : null;
  const log = [];

  for (const radius of MARKETCHECK_RADII) {
    const url = new URL('https://api.marketcheck.com/v2/search/car/active');
    url.searchParams.set('zip', zip || '78701');
    url.searchParams.set('radius', String(radius));
    url.searchParams.set('make', make);
    if (model) url.searchParams.set('model', model);
    if (yearMin && yearMax) url.searchParams.set('year_range', `${yearMin}-${yearMax}`);
    if (budgetMax) url.searchParams.set('price_range', `0-${Math.round(Number(budgetMax))}`);
    url.searchParams.set('rows', '20');

    const loggedQuery = url.toString();
    const fetchUrl = new URL(loggedQuery);
    fetchUrl.searchParams.set('api_key', env.MARKETCHECK_API_KEY);

    let listings = [];
    let errorNote;
    try {
      const res = await throttledFetch(fetchUrl.toString());
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        listings = data.listings || [];
      } else {
        errorNote = `HTTP ${res.status}`;
      }
    } catch (err) {
      errorNote = String(err);
    }

    const matched = listings.filter(l => {
      const listingYear = l.build?.year || null;
      if (yearMin && yearMax && (!listingYear || listingYear < yearMin || listingYear > yearMax)) return false;
      if (budgetMax && (l.price == null || l.price > Number(budgetMax))) return false;
      if (trim && !trimMatches(l.build?.trim, trim, l.build?.model, model)) return false;
      return true;
    });

    log.push({ radius, query: loggedQuery, raw_count: listings.length, matched_count: matched.length, error: errorNote });
    if (matched.length) return { listings: matched, radius, log };
  }

  return { listings: null, radius: null, log };
}

async function verifyListingLive(vdpUrl) {
  if (!vdpUrl) return 'unverified';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(vdpUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    return res.ok ? 'verified' : 'unverified';
  } catch {
    return 'unverified';
  }
}

function extractJsonLdVehicle(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const type = item['@type'];
        if (type === 'Vehicle' || type === 'Car' || (Array.isArray(type) && type.includes('Vehicle'))) return item;
      }
    } catch {}
  }
  return null;
}

function extractOgTags(html) {
  const get = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  return { title: get('title'), image: get('image') };
}

function extractPhotosFromPage(structuredData, ogData) {
  let photos = [];
  if (structuredData?.image) photos = Array.isArray(structuredData.image) ? structuredData.image : [structuredData.image];
  if (!photos.length && ogData?.image) photos = [ogData.image];
  return photos.filter(Boolean);
}

async function extractListingWithClaude(env, html, structuredData, ogData) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);

  const tool = {
    name: 'record_listing_data',
    description: 'Record vehicle listing details extracted from a dealer webpage.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer' }, make: { type: 'string' }, model: { type: 'string' }, trim: { type: 'string' },
        price: { type: 'integer' }, mileage: { type: 'integer' }, color: { type: 'string' },
        engine: { type: 'string' }, transmission: { type: 'string' }, drivetrain: { type: 'string' },
        found_confidence: { type: 'string', enum: ['high', 'low', 'none'], description: 'none if this page does not look like a vehicle listing at all' },
      },
      required: ['found_confidence'],
      additionalProperties: false,
    },
  };

  const prompt = `Extract vehicle listing details from this dealer webpage content. Only fill in fields you can confidently determine — omit uncertain ones.
${structuredData ? `\nStructured data found on page: ${JSON.stringify(structuredData).slice(0, 2000)}` : ''}
${ogData?.title ? `\nPage title: ${ogData.title}` : ''}

Page text content:
${cleaned}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, tools: [tool], tool_choice: { type: 'tool', name: 'record_listing_data' }, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { found_confidence: 'none' };
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : { found_confidence: 'none' };
}

async function adminScrapeListingUrl(request, env, params) {
  const report = await env.DB.prepare('SELECT id FROM find_car_reports WHERE report_code = ?').bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);
  const existing = await env.DB.prepare('SELECT * FROM report_vehicles WHERE report_id = ? AND position = ?').bind(report.id, +params.position).first();
  if (!existing) return json({ error: 'Vehicle not found.' }, 404);

  const body = await request.json().catch(() => ({}));
  const url = (body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return json({ error: 'Please paste a full listing URL.' }, 400);

  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheExactMatchBot/1.0)' } });
    if (!res.ok) return json({ error: `Could not fetch that page (HTTP ${res.status}). Fill in the fields below manually.` });
    html = await res.text();
  } catch {
    return json({ error: 'Could not fetch that page. Fill in the fields below manually.' });
  }

  const structuredData = extractJsonLdVehicle(html);
  const ogData = extractOgTags(html);
  const photos = extractPhotosFromPage(structuredData, ogData);
  const extracted = await extractListingWithClaude(env, html, structuredData, ogData);

  if (extracted.found_confidence === 'none') {
    return json({ error: "That page doesn't look like a vehicle listing. Fill in the fields below manually." });
  }

  const merged = {
    year: extracted.year ?? existing.year, make: extracted.make || existing.make,
    model: extracted.model || existing.model, trim: extracted.trim || existing.trim,
    price: extracted.price ?? existing.price, mileage: extracted.mileage ?? existing.mileage,
    exterior_color: extracted.color || existing.exterior_color,
    engine: extracted.engine || existing.engine, transmission: extracted.transmission || existing.transmission,
    drivetrain: extracted.drivetrain || existing.drivetrain,
    photo_url: photos[0] || existing.photo_url,
    photo_urls: JSON.stringify(photos.length ? photos : JSON.parse(existing.photo_urls || '[]')),
  };

  await env.DB.prepare(`
    UPDATE report_vehicles SET year=?, make=?, model=?, trim=?, price=?, mileage=?, exterior_color=?,
      engine=?, transmission=?, drivetrain=?, photo_url=?, photo_urls=?, vdp_url=? WHERE id=?
  `).bind(merged.year, merged.make, merged.model, merged.trim, merged.price, merged.mileage, merged.exterior_color,
    merged.engine, merged.transmission, merged.drivetrain, merged.photo_url, merged.photo_urls, url, existing.id).run();

  return json({ success: true, confidence: extracted.found_confidence });
}

async function enrichVehicleSpecs(env, vehicle, known) {
  const tool = {
    name: 'record_vehicle_specs',
    description: 'Record detailed factory specs for this specific vehicle trim.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        engine: { type: 'string' },
        transmission: { type: 'string' },
        drivetrain: { type: 'string' },
        city_mpg: { type: 'integer' },
        highway_mpg: { type: 'integer' },
        exterior_color_options: { type: 'string', description: 'Comma-separated factory color choices for this trim' },
        safety_rating: { type: 'string', description: 'e.g. IIHS Top Safety Pick+, NHTSA 5-star overall' },
        cargo_space: { type: 'string', description: 'e.g. 39.2 cu ft behind 2nd row' },
        seating_capacity: { type: 'integer' },
        warranty: { type: 'string', description: 'e.g. 3-year/36,000-mile basic, 5-year/60,000-mile powertrain' },
        notable_features: { type: 'array', items: { type: 'string' }, description: 'Notable standard features on this trim' },
      },
      required: ['engine', 'transmission', 'drivetrain', 'city_mpg', 'highway_mpg', 'exterior_color_options', 'safety_rating', 'cargo_space', 'seating_capacity', 'warranty', 'notable_features'],
      additionalProperties: false,
    },
  };

  const prompt = `Provide accurate factory specs for a ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}.` +
    (known.engine ? ` Known engine: ${known.engine}.` : '') +
    (known.transmission ? ` Known transmission: ${known.transmission}.` : '') +
    (known.drivetrain ? ` Known drivetrain: ${known.drivetrain}.` : '') +
    ` If a field is already known, just repeat it back — otherwise fill it in from real specifications for this exact year/make/model/trim.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 1024,
      tools: [tool], tool_choice: { type: 'tool', name: 'record_vehicle_specs' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.stop_reason === 'refusal') return {};
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : {};
}

async function findListingEntry(env, pick, lead, throttledFetch, tag, t0) {
  const searchMake = normalizeMakeForMarketcheck(pick.make);
  const searchResult = await searchMarketcheck(env, {
    make: searchMake, model: pick.model, trim: pick.trim, zip: lead.zip,
    year: pick.year, budgetMax: lead.budget_max, throttledFetch,
  });
  console.log(`[timing] ${tag} primary search: ${Date.now() - t0}ms, matched=${!!searchResult.listings}`);

  if (searchResult.listings) {
    const l = searchResult.listings[0];
    const tVerify = Date.now();
    const verified = await verifyListingLive(l.vdp_url);
    console.log(`[timing] ${tag} verify: ${Date.now() - tVerify}ms`);
    return {
      ...pick,
      price: l.price ?? null,
      mileage: l.miles ?? null,
      dealer_name: l.dealer?.name || null,
      dealer_city: l.dealer?.city || null,
      dealer_state: l.dealer?.state || null,
      vdp_url: l.vdp_url || null,
      source: 'marketcheck',
      verified,
      engine: l.build?.engine || null,
      transmission: l.build?.transmission || null,
      drivetrain: l.build?.drivetrain || null,
      city_mpg: l.build?.city_mpg ?? null,
      highway_mpg: l.build?.highway_mpg ?? null,
      exterior_color: l.exterior_color || null,
      photo_url: l.media?.photo_links_cached?.[0] || l.media?.photo_links?.[0] || null,
      photo_urls: JSON.stringify(l.media?.photo_links_cached || l.media?.photo_links || []),
      search_log: JSON.stringify(searchResult.log),
    };
  }

  const tFallback = Date.now();
  const franchiseResult = await searchMarketcheck(env, { make: searchMake, model: null, zip: lead.zip, throttledFetch });
  console.log(`[timing] ${tag} franchise fallback: ${Date.now() - tFallback}ms`);
  const nearestDealer = franchiseResult.listings ? franchiseResult.listings[0].dealer : null;
  const fullLog = [...searchResult.log, ...franchiseResult.log.map(l => ({ ...l, note: 'franchise fallback (make-only) search' }))];
  return {
    ...pick,
    price: null, mileage: null, vdp_url: null, photo_url: null, photo_urls: '[]',
    dealer_name: nearestDealer?.name || null,
    dealer_city: nearestDealer?.city || null,
    dealer_state: nearestDealer?.state || null,
    engine: null, transmission: null, drivetrain: null,
    city_mpg: null, highway_mpg: null, exterior_color: null,
    source: 'sourcing_in_progress',
    verified: 'sourcing_in_progress',
    search_log: JSON.stringify(fullLog),
  };
}

async function processVehiclePick(env, pick, lead, throttledFetch) {
  const t0 = Date.now();
  const tag = `${pick.year} ${pick.make} ${pick.model}`;

  // Listing search and spec enrichment are independent — Claude's spec recall
  // doesn't require the Marketcheck result, so run them concurrently instead
  // of stacking their latencies in series (this pipeline is on a tight ~30s
  // ctx.waitUntil() budget).
  const [entry, specs] = await Promise.all([
    findListingEntry(env, pick, lead, throttledFetch, tag, t0),
    (async () => {
      const tSpecs = Date.now();
      const result = await enrichVehicleSpecs(env, pick, {});
      console.log(`[timing] ${tag} enrichSpecs: ${Date.now() - tSpecs}ms`);
      return result;
    })(),
  ]);

  entry.engine = entry.engine || specs.engine || null;
  entry.transmission = entry.transmission || specs.transmission || null;
  entry.drivetrain = entry.drivetrain || specs.drivetrain || null;
  entry.city_mpg = entry.city_mpg ?? specs.city_mpg ?? null;
  entry.highway_mpg = entry.highway_mpg ?? specs.highway_mpg ?? null;
  entry.exterior_color_options = specs.exterior_color_options || null;
  entry.safety_rating = specs.safety_rating || null;
  entry.cargo_space = specs.cargo_space || null;
  entry.seating_capacity = specs.seating_capacity ?? null;
  entry.warranty = specs.warranty || null;
  entry.notable_features = JSON.stringify(specs.notable_features || []);

  console.log(`[timing] ${tag} TOTAL: ${Date.now() - t0}ms`);
  return entry;
}

function createMarketcheckThrottle(maxConcurrent = 3) {
  let active = 0;
  const queue = [];

  function pump() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { url, resolve, reject } = queue.shift();
    (async () => {
      try {
        let res = await fetch(url);
        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 800));
          res = await fetch(url);
        }
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        active--;
        pump();
      }
    })();
  }

  return function throttledFetch(url) {
    return new Promise((resolve, reject) => {
      queue.push({ url, resolve, reject });
      pump();
    });
  };
}

async function generateReportForLead(env, leadId) {
  const t0 = Date.now();
  const lead = await env.DB.prepare('SELECT * FROM find_car_leads WHERE id = ?').bind(leadId).first();
  if (!lead) return;

  const picks = await pickVehicles(env, lead);
  console.log(`[timing] pickVehicles: ${Date.now() - t0}ms`);
  const throttledFetch = createMarketcheckThrottle();
  const tVehicles = Date.now();
  const vehicles = await Promise.all(picks.map(pick => processVehiclePick(env, pick, lead, throttledFetch)));
  console.log(`[timing] all vehicles processed: ${Date.now() - tVehicles}ms, cumulative: ${Date.now() - t0}ms`);

  const reportResult = await env.DB.prepare(
    `INSERT INTO find_car_reports (report_code, find_lead_id, status) VALUES ('', ?, 'pending_approval')`
  ).bind(leadId).run();
  const reportId = reportResult.meta.last_row_id;
  const reportCode = `TEM-${new Date().getFullYear()}-${String(reportId).padStart(4, '0')}`;
  await env.DB.prepare('UPDATE find_car_reports SET report_code = ? WHERE id = ?').bind(reportCode, reportId).run();

  for (let i = 0; i < vehicles.length; i++) {
    const v = vehicles[i];
    await env.DB.prepare(`
      INSERT INTO report_vehicles (
        report_id, position, year, make, model, trim, rationale, price, mileage, dealer_name, dealer_city, dealer_state, vdp_url, source, verified,
        engine, transmission, drivetrain, city_mpg, highway_mpg, exterior_color, exterior_color_options,
        safety_rating, cargo_space, seating_capacity, warranty, notable_features, photo_url, photo_urls, search_log
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId, i + 1, v.year, v.make, v.model, v.trim, v.rationale,
      v.price, v.mileage, v.dealer_name, v.dealer_city, v.dealer_state, v.vdp_url, v.source, v.verified,
      v.engine, v.transmission, v.drivetrain, v.city_mpg, v.highway_mpg, v.exterior_color, v.exterior_color_options,
      v.safety_rating, v.cargo_space, v.seating_capacity, v.warranty, v.notable_features, v.photo_url, v.photo_urls, v.search_log
    ).run();
  }

  await sendBrevoEmail(env, {
    to: 'theexactmatch@gmail.com',
    subject: 'New report ready for review',
    html: brandedEmailHtml(`
      <p>New Find My Car report ready for ${escapeHtml(lead.first_name)} ${escapeHtml(lead.last_name)}.</p>
      <p><strong>Verify these are still live before approving:</strong></p>
      <ul>
        ${vehicles.map(v => `
          <li style="margin-bottom:.5rem">
            ${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} ${escapeHtml(v.trim)} —
            ${v.source === 'sourcing_in_progress'
              ? `<strong style="color:#9B2335">⚠ Needs manual sourcing</strong>${v.dealer_name ? ` — nearest ${escapeHtml(v.make)} dealer: ${escapeHtml(v.dealer_name)}` : ''}`
              : (v.vdp_url
                  ? `<a href="${escapeHtml(v.vdp_url)}">View listing →</a> (${escapeHtml(v.verified)})`
                  : `no direct link — ${escapeHtml(v.source)}, dealer: ${escapeHtml(v.dealer_name || 'unknown')}`)}
          </li>
        `).join('')}
      </ul>
      <p><a href="https://theexactmatch.com/Dealerportal.html">Review &amp; approve in dashboard →</a></p>
    `),
  });
}

// ── Sell My Car valuation pipeline ────────────────────────────────
async function decodeVin(env, vin) {
  if (!vin || vin.length !== 17) return null;
  try {
    const url = new URL(`https://api.marketcheck.com/v2/decode/car/${encodeURIComponent(vin)}/specs`);
    url.searchParams.set('api_key', env.MARKETCHECK_API_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.is_valid === false) return null;
    return data;
  } catch {
    return null;
  }
}

async function searchMarketcheckComps(env, { make, model, trim, zip, year, mileage, throttledFetch }) {
  if (!make) return { comps: [], log: [{ note: 'No make/model available to search comps.' }] };

  const yearMin = year ? Number(year) - 2 : null;
  const yearMax = year ? Number(year) + 2 : null;
  const log = [];

  for (const radius of MARKETCHECK_RADII) {
    const url = new URL('https://api.marketcheck.com/v2/search/car/active');
    url.searchParams.set('zip', zip || '78701');
    url.searchParams.set('radius', String(radius));
    url.searchParams.set('make', make);
    if (model) url.searchParams.set('model', model);
    if (yearMin && yearMax) url.searchParams.set('year_range', `${yearMin}-${yearMax}`);
    url.searchParams.set('rows', '20');

    const loggedQuery = url.toString();
    const fetchUrl = new URL(loggedQuery);
    fetchUrl.searchParams.set('api_key', env.MARKETCHECK_API_KEY);

    let listings = [];
    let errorNote;
    try {
      const res = await throttledFetch(fetchUrl.toString());
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        listings = data.listings || [];
      } else {
        errorNote = `HTTP ${res.status}`;
      }
    } catch (err) {
      errorNote = String(err);
    }

    const matched = listings.filter(l => {
      const listingYear = l.build?.year || null;
      if (yearMin && yearMax && (!listingYear || listingYear < yearMin || listingYear > yearMax)) return false;
      if (trim && !trimMatches(l.build?.trim, trim, l.build?.model, model)) return false;
      return true;
    });

    log.push({ radius, query: loggedQuery, raw_count: listings.length, matched_count: matched.length, error: errorNote });

    if (matched.length) {
      if (mileage) matched.sort((a, b) => Math.abs((a.miles ?? mileage) - mileage) - Math.abs((b.miles ?? mileage) - mileage));
      return { comps: matched.slice(0, 15), log };
    }
  }

  return { comps: [], log };
}

function buildValuationPrompt({ vehicle, mileage, comps, selfReported, photoAssessment }) {
  const compsText = comps.length
    ? comps.map(c => `- ${c.build?.year || '?'} ${c.build?.make || ''} ${c.build?.model || ''} ${c.build?.trim || ''}, ${c.miles != null ? Number(c.miles).toLocaleString() + ' mi' : 'mileage unknown'}, listed at $${c.price != null ? Number(c.price).toLocaleString() : '?'} — ${c.dealer?.city || ''}${c.dealer?.state ? ', ' + c.dealer.state : ''}`).join('\n')
    : 'No comparable active retail listings were found for this spec/mileage/region.';

  const photoCaveat = photoAssessment
    ? 'You have now reviewed photos of this vehicle (see the photo-confirmed condition assessment below) — weight that over the self-report where they differ.'
    : 'You have NOT seen photos yet, so weight the self-reported details accordingly and be conservative if the self-report suggests anything below excellent condition.';

  const photoSection = photoAssessment ? `

Photo-confirmed condition assessment:
- Exterior: ${photoAssessment.exterior_score}/10 — ${photoAssessment.exterior_notes}
- Interior: ${photoAssessment.interior_score}/10 — ${photoAssessment.interior_notes}
- Tires: ${photoAssessment.tires_score}/10 — ${photoAssessment.tires_notes}
- Engine bay: ${photoAssessment.engine_bay_score}/10 — ${photoAssessment.engine_bay_notes}
${photoAssessment.mismatches?.length ? `- Mismatches vs. self-report: ${photoAssessment.mismatches.join('; ')}` : '- No mismatches vs. self-report noted.'}
` : '';

  return `A client is selling their vehicle through our "Sell My Car" service. Estimate three values for this vehicle: retail comp value (what a dealer would likely list it for at retail), trade-in value (what a dealer would offer to acquire it outright), and private-sale value (what a private-party buyer would likely pay). Base your estimate on the comparable listings below and the client's self-reported condition/accident/mechanical information. ${photoCaveat}

Vehicle: ${vehicle.year || '?'} ${vehicle.make || '?'} ${vehicle.model || '?'} ${vehicle.trim || ''}
Mileage: ${mileage != null ? Number(mileage).toLocaleString() + ' mi' : 'not provided'}

Self-reported condition:
- General condition: ${selfReported.general_condition || 'not specified'}
- Accident history: ${selfReported.accident_history}${selfReported.accident_notes ? ` — ${selfReported.accident_notes}` : ''}
- Mechanical status: ${selfReported.mechanical_status || 'not specified'}${selfReported.mechanical_notes ? ` — ${selfReported.mechanical_notes}` : ''}
${photoSection}
Comparable active retail listings:
${compsText}

For each of the three values, give a short reasoning (2-3 sentences) grounded in the comps${photoAssessment ? ', the photo-confirmed condition,' : ' and the self-reported condition'}.`;
}

async function synthesizeValuation(env, args) {
  const tool = {
    name: 'record_valuation',
    description: 'Record the three valuation figures for this vehicle, each with reasoning.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        retail_value: { type: 'integer', description: 'Estimated retail comp value in USD' },
        retail_reasoning: { type: 'string' },
        trade_in_value: { type: 'integer', description: 'Estimated dealer trade-in value in USD' },
        trade_in_reasoning: { type: 'string' },
        private_sale_value: { type: 'integer', description: 'Estimated private-party sale value in USD' },
        private_sale_reasoning: { type: 'string' },
      },
      required: ['retail_value', 'retail_reasoning', 'trade_in_value', 'trade_in_reasoning', 'private_sale_value', 'private_sale_reasoning'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_valuation' },
      messages: [{ role: 'user', content: buildValuationPrompt(args) }],
    }),
  });

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the valuation request');
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block: ' + JSON.stringify(data));
  return toolUse.input;
}

function sendSellCarReceivedEmail(env, { first_name, email, token }) {
  const uploadUrl = `https://theexactmatch.com/sell/upload/${token}`;
  const html = brandedEmailHtml(`
    <p>Hey ${escapeHtml(first_name)},</p>
    <p>We got your vehicle info and we're already working on it. To get you an accurate offer, we just need a few photos.</p>
    <p><a href="${uploadUrl}">Upload photos of your vehicle →</a></p>
    <p>It only takes a couple minutes, and it's the last step before we get you real numbers.</p>
    <p>— Jeff</p>
  `);
  return sendBrevoEmail(env, {
    to: email,
    subject: "We've got your vehicle info — a few photos and we're set",
    html,
  });
}

async function generateValuationForLead(env, leadId, input) {
  const t0 = Date.now();
  const lead = await env.DB.prepare('SELECT * FROM sell_my_car_leads WHERE id = ?').bind(leadId).first();
  if (!lead) return;

  const decoded = await decodeVin(env, input.vin);
  console.log(`[timing] valuation lead ${leadId} decode: ${Date.now() - t0}ms, decoded=${!!decoded}`);

  const vehicle = {
    year:  decoded?.year  || input.year  || null,
    make:  decoded?.make  || input.make  || null,
    model: decoded?.model || input.model || null,
    trim:  decoded?.trim  || input.trim  || null,
  };

  const throttledFetch = createMarketcheckThrottle();
  const tComps = Date.now();
  const { comps, log } = await searchMarketcheckComps(env, {
    make: normalizeMakeForMarketcheck(vehicle.make), model: vehicle.model, trim: vehicle.trim,
    zip: input.zip, year: vehicle.year, mileage: input.mileage, throttledFetch,
  });
  console.log(`[timing] valuation lead ${leadId} comps: ${Date.now() - tComps}ms, count=${comps.length}`);

  const selfReported = {
    general_condition: input.general_condition || null,
    accident_history: input.accident_history || 'none',
    accident_notes: input.accident_notes || null,
    mechanical_status: input.mechanical_status || null,
    mechanical_notes: input.mechanical_notes || null,
  };

  const tSynth = Date.now();
  const valuation = await synthesizeValuation(env, { vehicle, mileage: input.mileage, comps, selfReported });
  console.log(`[timing] valuation lead ${leadId} synthesis: ${Date.now() - tSynth}ms`);

  const token = randomHex(20);
  await env.DB.prepare(`
    INSERT INTO vehicle_valuations (
      lead_id, token, vin, decoded_year, decoded_make, decoded_model, decoded_trim, decoded_engine, decoded_drivetrain, decoded_body_type, decode_raw,
      mileage, accident_history, accident_notes, general_condition, mechanical_status, mechanical_notes,
      marketcheck_comps, marketcheck_log,
      final_retail_value, final_trade_in_value, final_private_sale_value, valuation_reasoning,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_photos')
  `).bind(
    leadId, token, input.vin || null,
    decoded?.year ?? null, decoded?.make || null, decoded?.model || null, decoded?.trim || null,
    decoded?.engine || null, decoded?.drivetrain || null, decoded?.body_type || null, decoded ? JSON.stringify(decoded) : null,
    input.mileage ?? null, selfReported.accident_history, selfReported.accident_notes,
    selfReported.general_condition, selfReported.mechanical_status, selfReported.mechanical_notes,
    JSON.stringify(comps), JSON.stringify(log),
    valuation.retail_value, valuation.trade_in_value, valuation.private_sale_value,
    JSON.stringify({ retail: valuation.retail_reasoning, trade_in: valuation.trade_in_reasoning, private_sale: valuation.private_sale_reasoning })
  ).run();

  await sendSellCarReceivedEmail(env, { first_name: lead.first_name, email: lead.email, token });

  console.log(`[timing] valuation lead ${leadId} TOTAL: ${Date.now() - t0}ms`);
}

// ── Sell My Car photo upload + photo-confirmed re-valuation ──────
const SELL_PHOTO_SLOTS = [
  { key: 'front_34',       label: 'Front 3/4',                      multi: false },
  { key: 'rear_34',        label: 'Rear 3/4',                       multi: false },
  { key: 'driver_side',    label: 'Driver Side',                    multi: false },
  { key: 'passenger_side', label: 'Passenger Side',                 multi: false },
  { key: 'odometer',       label: 'Odometer',                       multi: false },
  { key: 'dashboard',      label: 'Dashboard / Instrument Cluster', multi: false },
  { key: 'front_seats',    label: 'Front Seats',                    multi: false },
  { key: 'rear_seats',     label: 'Rear Seats',                     multi: false },
  { key: 'tires',          label: 'All 4 Tires (Tread)',            multi: true, maxFiles: 4 },
  { key: 'engine_bay',     label: 'Engine Bay',                     multi: false },
  { key: 'vin_plate',      label: 'VIN Plate (Door Jamb/Dash)',     multi: false },
];
const SELL_PHOTO_ISSUE_SLOT = { key: 'issue', label: 'Flag an Issue (optional)', multi: true, maxFiles: 4 };
const SELL_PHOTO_ALL_SLOTS = [...SELL_PHOTO_SLOTS, SELL_PHOTO_ISSUE_SLOT];
const SELL_PHOTO_REQUIRED_KEYS = SELL_PHOTO_SLOTS.map(s => s.key);

function buildConditionAssessmentPrompt({ selfReported }) {
  return `A client submitted photos of their vehicle for a "Sell My Car" valuation. Review the photos (grouped and labeled by area above) and score the condition of each area. Then compare what you see to the client's self-reported condition and flag any mismatches — for example, if they said "excellent" condition but the tires show heavy wear, or said no accidents but photos show visible collision damage or panel misalignment.

Client's self-reported condition:
- General condition: ${selfReported.general_condition || 'not specified'}
- Accident history: ${selfReported.accident_history}${selfReported.accident_notes ? ` — ${selfReported.accident_notes}` : ''}
- Mechanical status: ${selfReported.mechanical_status || 'not specified'}${selfReported.mechanical_notes ? ` — ${selfReported.mechanical_notes}` : ''}

Score each area 1-10 (10 = like-new) based only on what's visible in the photos.`;
}

async function assessConditionFromPhotos(env, { selfReported, photosBySlot }) {
  const tool = {
    name: 'record_condition_assessment',
    description: 'Record a per-area condition assessment from vehicle photos, and any mismatches against the self-reported condition.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        exterior_score: { type: 'integer', description: '1-10, based on body/paint photos' },
        exterior_notes: { type: 'string' },
        interior_score: { type: 'integer', description: '1-10, based on seat/dashboard photos' },
        interior_notes: { type: 'string' },
        tires_score: { type: 'integer', description: '1-10, based on tire tread photos' },
        tires_notes: { type: 'string' },
        engine_bay_score: { type: 'integer', description: '1-10, based on engine bay photo' },
        engine_bay_notes: { type: 'string' },
        mismatches: { type: 'array', items: { type: 'string' }, description: 'Each entry describes one mismatch between self-reported condition and what the photos show. Empty array if none.' },
        overall_assessment: { type: 'string', description: '2-3 sentence overall summary of condition based on photos' },
      },
      required: ['exterior_score', 'exterior_notes', 'interior_score', 'interior_notes', 'tires_score', 'tires_notes', 'engine_bay_score', 'engine_bay_notes', 'mismatches', 'overall_assessment'],
      additionalProperties: false,
    },
  };

  const content = [];
  for (const slotDef of SELL_PHOTO_ALL_SLOTS) {
    const urls = photosBySlot[slotDef.key] || [];
    if (!urls.length) continue;
    content.push({ type: 'text', text: `${slotDef.label}:` });
    for (const url of urls) content.push({ type: 'image', source: { type: 'url', url } });
  }
  content.push({ type: 'text', text: buildConditionAssessmentPrompt({ selfReported }) });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_condition_assessment' },
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the condition assessment request');
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block: ' + JSON.stringify(data));
  return toolUse.input;
}

function sendSellCarValueRangeEmail(env, { first_name, email, low, high, token }) {
  const reportUrl = `https://theexactmatch.com/sell/report/${token}`;
  const html = brandedEmailHtml(`
    <p>Hey ${escapeHtml(first_name)},</p>
    <p>Thanks for sending over the photos. Based on everything you've shared, here's your rough value range:</p>
    <p style="font-family:Georgia,serif;font-size:1.4rem;color:#0C1C33;text-align:center;margin:1.5rem 0"><strong>$${Number(low).toLocaleString()} – $${Number(high).toLocaleString()}</strong></p>
    <p style="font-size:.8rem;color:#4A5568">Based on self-reported and photo-confirmed information, subject to revision.</p>
    <p><a href="${reportUrl}">View your full valuation report →</a></p>
    <p>Jeff will follow up shortly with next steps.</p>
    <p>— Jeff</p>
  `);
  return sendBrevoEmail(env, {
    to: email,
    subject: 'Your rough value range is ready',
    html,
  });
}

async function processPhotoConfirmedValuation(env, token) {
  const t0 = Date.now();
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*, sell_my_car_leads.first_name, sell_my_car_leads.email,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.token = ?
  `).bind(token).first();
  if (!valuation) return;

  const photosBySlot = await fetchPhotosBySlot(env, valuation.id);

  const selfReported = {
    general_condition: valuation.general_condition,
    accident_history: valuation.accident_history,
    accident_notes: valuation.accident_notes,
    mechanical_status: valuation.mechanical_status,
    mechanical_notes: valuation.mechanical_notes,
  };

  const assessment = await assessConditionFromPhotos(env, { selfReported, photosBySlot });
  console.log(`[timing] photo valuation ${token} assessment: ${Date.now() - t0}ms`);

  let comps = [];
  try { comps = JSON.parse(valuation.marketcheck_comps || '[]'); } catch { comps = []; }

  const vehicle = {
    year:  valuation.decoded_year  || valuation.lead_year  || null,
    make:  valuation.decoded_make  || valuation.lead_make  || null,
    model: valuation.decoded_model || valuation.lead_model || null,
    trim:  valuation.decoded_trim  || valuation.lead_trim  || null,
  };

  const tSynth = Date.now();
  const revaluation = await synthesizeValuation(env, {
    vehicle, mileage: valuation.mileage, comps, selfReported, photoAssessment: assessment,
  });
  console.log(`[timing] photo valuation ${token} synthesis: ${Date.now() - tSynth}ms`);

  await env.DB.prepare(`
    UPDATE vehicle_valuations SET
      ai_condition_score = ?, photo_confirmed = 1,
      final_retail_value = ?, final_trade_in_value = ?, final_private_sale_value = ?,
      valuation_reasoning = ?, status = 'valued', customer_notified_at = datetime('now')
    WHERE id = ?
  `).bind(
    JSON.stringify(assessment),
    revaluation.retail_value, revaluation.trade_in_value, revaluation.private_sale_value,
    JSON.stringify({ retail: revaluation.retail_reasoning, trade_in: revaluation.trade_in_reasoning, private_sale: revaluation.private_sale_reasoning }),
    valuation.id
  ).run();

  await sendSellCarValueRangeEmail(env, {
    first_name: valuation.first_name, email: valuation.email, token,
    low: Math.min(revaluation.retail_value, revaluation.trade_in_value, revaluation.private_sale_value),
    high: Math.max(revaluation.retail_value, revaluation.trade_in_value, revaluation.private_sale_value),
  });

  console.log(`[timing] photo valuation ${token} TOTAL: ${Date.now() - t0}ms`);
}

function sellNotFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Link Not Found — TheExactMatch</title>
<style>body{font-family:sans-serif;background:#F5F0E8;color:#0C1C33;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:3rem;max-width:480px}</style></head><body>
<div class="box"><h1>Link not found</h1><p>This upload link is invalid or has expired. Contact Jeff at (512) 650-9328 if you think this is a mistake.</p></div>
</body></html>`;
}

function sellUploadPageHtml(valuation, photosBySlot) {
  const vehicleLabel = [
    valuation.decoded_year || valuation.lead_year, valuation.decoded_make || valuation.lead_make,
    valuation.decoded_model || valuation.lead_model, valuation.decoded_trim || valuation.lead_trim,
  ].filter(Boolean).join(' ');

  const slotCard = (slot) => {
    const urls = photosBySlot[slot.key] || [];
    return `
    <div class="slot-card">
      <div class="slot-label">${escapeHtml(slot.label)}${slot.multi ? ` <span class="slot-hint">(up to ${slot.maxFiles})</span>` : ''}</div>
      <div class="slot-thumbs" id="thumbs-${slot.key}">${urls.map(u => `<img src="${escapeHtml(u)}" class="thumb"/>`).join('')}</div>
      <label class="slot-upload-btn">
        Choose Photo${slot.multi ? 's' : ''}
        <input type="file" accept="image/*" ${slot.multi ? 'multiple' : ''} onchange="uploadSlotPhoto('${valuation.token}','${slot.key}', this)"/>
      </label>
      <div class="slot-status" id="status-${slot.key}">${urls.length ? '✓ uploaded' : ''}</div>
    </div>`;
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Upload Vehicle Photos — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--navy:#0C1C33;--navy2:#152a4a;--beige:#F5F0E8;--beige2:#EDE7D9;--gold:#C09A5B;--gold2:#D4B47A;--white:#fff;--gray:#4A5568;--border:#DDD8CC;--green:#1A4731}
  body{font-family:'Jost',sans-serif;background:var(--beige);color:var(--navy)}
  header{background:var(--navy);padding:3rem 2rem;text-align:center}
  .eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold2);margin-bottom:.75rem}
  h1{font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.2rem);font-weight:500;color:var(--white)}
  h1 em{font-style:italic;color:var(--gold2)}
  .sub{color:rgba(255,255,255,.55);font-size:.9rem;margin-top:.75rem;font-weight:300}
  .wrap{max-width:900px;margin:0 auto;padding:3rem 2rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.25rem;margin-bottom:2rem}
  .slot-card{background:var(--white);border:1px solid var(--border);border-radius:4px;padding:1.25rem;display:flex;flex-direction:column;gap:.6rem}
  .slot-label{font-size:.85rem;font-weight:500;color:var(--navy)}
  .slot-hint{font-size:.7rem;color:var(--gray);font-weight:300}
  .slot-thumbs{display:flex;flex-wrap:wrap;gap:.4rem}
  .thumb{width:64px;height:64px;object-fit:cover;border-radius:3px;border:1px solid var(--border)}
  .slot-upload-btn{display:inline-block;padding:.55rem .9rem;background:var(--beige2);border:1px solid var(--border);border-radius:2px;font-size:.72rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--navy);cursor:pointer;text-align:center}
  .slot-upload-btn input{display:none}
  .slot-status{font-size:.72rem;color:var(--green);font-weight:600;min-height:1em}
  .cta-wrap{text-align:center}
  .cta-btn{padding:1rem 2.5rem;background:var(--gold);color:var(--navy);border:none;border-radius:2px;font-family:'Jost',sans-serif;font-weight:700;font-size:.85rem;letter-spacing:.04em;cursor:pointer}
  .cta-btn:disabled{background:var(--border);color:var(--gray);cursor:not-allowed}
  .success-box{display:none;text-align:center;padding:3rem 2rem}
  .success-box h2{font-family:'Playfair Display',serif;font-size:1.5rem;margin-bottom:1rem}
  footer{text-align:center;padding:2rem;font-size:.72rem;color:var(--gray)}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Sell My Car</div>
  <h1>Hi ${escapeHtml(valuation.first_name)}, let's see <em>your ${escapeHtml(vehicleLabel || 'vehicle')}.</em></h1>
  <div class="sub">A few photos and we'll have your value range ready. Questions? Text Jeff at (512) 650-9328.</div>
</header>
<div class="wrap">
  <div id="upload-wrap">
    <div class="grid">
      ${SELL_PHOTO_SLOTS.map(slotCard).join('')}
      ${slotCard(SELL_PHOTO_ISSUE_SLOT)}
    </div>
    <div class="cta-wrap">
      <button class="cta-btn" id="submit-photos-btn" disabled onclick="submitPhotos('${valuation.token}')">Submit Photos</button>
    </div>
  </div>
  <div class="success-box" id="upload-success">
    <h2>✦ Photos received.</h2>
    <p style="color:var(--gray)">Thanks! Jeff will review everything and follow up with your numbers shortly.</p>
  </div>
</div>
<footer>© ${new Date().getFullYear()} TheExactMatch.com</footer>
<script>
const REQUIRED_SLOTS = ${JSON.stringify(SELL_PHOTO_REQUIRED_KEYS)};
const API_BASE = 'https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api/public/sell';

function checkAllUploaded() {
  const allDone = REQUIRED_SLOTS.every(key => document.querySelectorAll('#thumbs-' + key + ' img').length > 0);
  document.getElementById('submit-photos-btn').disabled = !allDone;
}

async function uploadSlotPhoto(token, slot, input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  const statusEl = document.getElementById('status-' + slot);
  const thumbsEl = document.getElementById('thumbs-' + slot);
  statusEl.textContent = 'Uploading…'; statusEl.style.color = 'var(--gray)';

  for (const file of files) {
    const fd = new FormData();
    fd.append('photo', file);
    try {
      const res = await fetch(API_BASE + '/' + token + '/photo/' + slot, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        const img = document.createElement('img');
        img.src = data.url; img.className = 'thumb';
        thumbsEl.appendChild(img);
      } else {
        statusEl.textContent = data.error || 'Upload failed.'; statusEl.style.color = '#9B2335';
        return;
      }
    } catch (e) {
      statusEl.textContent = 'Upload failed. Try again.'; statusEl.style.color = '#9B2335';
      return;
    }
  }
  statusEl.textContent = '✓ uploaded'; statusEl.style.color = 'var(--green)';
  input.value = '';
  checkAllUploaded();
}

async function submitPhotos(token) {
  const btn = document.getElementById('submit-photos-btn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const res = await fetch(API_BASE + '/' + token + '/complete', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      document.getElementById('upload-wrap').style.display = 'none';
      document.getElementById('upload-success').style.display = 'block';
    } else {
      btn.disabled = false; btn.textContent = 'Submit Photos';
      alert(data.error || 'Could not submit. Please try again.');
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Submit Photos';
    alert('Could not submit. Please try again.');
  }
}

checkAllUploaded();
</script>
</body></html>`;
}

async function renderSellUploadPage(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*, sell_my_car_leads.first_name,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.token = ?
  `).bind(params.token).first();

  if (!valuation) return htmlResponse(sellNotFoundHtml(), 404);

  const photosBySlot = await fetchPhotosBySlot(env, valuation.id);

  return htmlResponse(sellUploadPageHtml(valuation, photosBySlot));
}

async function serveSellPhoto(env, params, method) {
  const key = `sell/${params.token}/${params.slot}/${params.filename}`;
  const object = method === 'HEAD' ? await env.PHOTOS.head(key) : await env.PHOTOS.get(key);
  if (!object) return new Response(method === 'HEAD' ? null : 'Not found', { status: 404 });
  return new Response(method === 'HEAD' ? null : object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  });
}

async function storeValuationPhoto(env, valuation, slot, file) {
  const slotDef = SELL_PHOTO_ALL_SLOTS.find(s => s.key === slot);
  if (!slotDef) return { error: 'Unknown photo slot.' };

  const { results: existing } = await env.DB.prepare(
    'SELECT id, url FROM valuation_photos WHERE valuation_id = ? AND slot = ?'
  ).bind(valuation.id, slot).all();

  if (slotDef.multi) {
    if (existing.length >= slotDef.maxFiles) {
      return { error: `You can upload up to ${slotDef.maxFiles} photos for this.` };
    }
  } else if (existing.length) {
    for (const row of existing) {
      const oldFilename = row.url.split('/').pop();
      await env.PHOTOS.delete(`sell/${valuation.token}/${slot}/${oldFilename}`).catch(() => {});
    }
    await env.DB.prepare('DELETE FROM valuation_photos WHERE valuation_id = ? AND slot = ?').bind(valuation.id, slot).run();
  }

  const ext = (file.type || 'image/jpeg').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const filename = `${randomHex(8)}.${ext}`;
  const key = `sell/${valuation.token}/${slot}/${filename}`;
  await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'image/jpeg' } });

  const url = `https://theexactmatch.com/sell/photos/${valuation.token}/${slot}/${filename}`;
  await env.DB.prepare('INSERT INTO valuation_photos (valuation_id, slot, url) VALUES (?, ?, ?)').bind(valuation.id, slot, url).run();

  return { url };
}

async function uploadSellPhoto(request, env, params) {
  const valuation = await env.DB.prepare('SELECT id, token FROM vehicle_valuations WHERE token = ?').bind(params.token).first();
  if (!valuation) return json({ error: 'Upload link not found.' }, 404);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'No photo file provided.' }, 400);

  const result = await storeValuationPhoto(env, valuation, params.slot, file);
  if (result.error) return json({ error: result.error }, 400);
  return json({ success: true, url: result.url });
}

async function adminUploadValuationPhoto(request, env, params) {
  const valuation = await env.DB.prepare('SELECT id, token, status FROM vehicle_valuations WHERE lead_id = ?').bind(+params.id).first();
  if (!valuation) return json({ error: 'No valuation found for this lead yet. It may still be processing — try again shortly.' }, 404);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'No photo file provided.' }, 400);

  const result = await storeValuationPhoto(env, valuation, params.slot, file);
  if (result.error) return json({ error: result.error }, 400);

  if (valuation.status === 'pending_photos') {
    await env.DB.prepare(`UPDATE vehicle_valuations SET status = 'photos_received', photos_uploaded_at = COALESCE(photos_uploaded_at, datetime('now')) WHERE id = ?`).bind(valuation.id).run();
  }

  return json({ success: true, url: result.url });
}

async function completeSellPhotos(request, env, params, dealer, sessionToken, ctx) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.id,
      sell_my_car_leads.first_name, sell_my_car_leads.last_name,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make, sell_my_car_leads.model AS lead_model,
      vehicle_valuations.decoded_year, vehicle_valuations.decoded_make, vehicle_valuations.decoded_model
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.token = ?
  `).bind(params.token).first();
  if (!valuation) return json({ error: 'Upload link not found.' }, 404);

  const { results: photoRows } = await env.DB.prepare(
    'SELECT DISTINCT slot FROM valuation_photos WHERE valuation_id = ?'
  ).bind(valuation.id).all();
  const uploadedSlots = new Set(photoRows.map(r => r.slot));
  const missing = SELL_PHOTO_REQUIRED_KEYS.filter(key => !uploadedSlots.has(key));
  if (missing.length) {
    const labels = missing.map(k => SELL_PHOTO_SLOTS.find(s => s.key === k).label);
    return json({ error: `Please upload a photo for: ${labels.join(', ')}.` }, 400);
  }

  await env.DB.prepare(`UPDATE vehicle_valuations SET status = 'photos_received', photos_uploaded_at = datetime('now') WHERE id = ?`).bind(valuation.id).run();

  // Automated Claude vision re-valuation (processPhotoConfirmedValuation) is paused for
  // now — Anthropic's URL-based image fetch is currently failing account-wide, unrelated
  // to Cloudflare. Notify admin to review the uploaded photos manually instead.
  if (ctx) {
    const vehicleLabel = `${valuation.decoded_year || valuation.lead_year || ''} ${valuation.decoded_make || valuation.lead_make || ''} ${valuation.decoded_model || valuation.lead_model || ''}`.trim();
    ctx.waitUntil(sendBrevoEmail(env, {
      to: 'theexactmatch@gmail.com',
      subject: '📸 Photos received — ready for review',
      html: brandedEmailHtml(`
        <p><strong>${escapeHtml(valuation.first_name)} ${escapeHtml(valuation.last_name)}</strong> uploaded all their photos for the ${escapeHtml(vehicleLabel)}.</p>
        <p><a href="https://theexactmatch.com/Dealerportal.html">Review photos &amp; confirm values →</a></p>
      `),
    }).catch(err => console.error('photos-received admin email failed', params.token, err)));
  }

  return json({ success: true });
}

// ── Hosted seller report ──────────────────────────────────────────
function sellReportPendingHtml(valuation) {
  const message = valuation.status === 'pending_photos'
    ? `<p>We're still waiting on your photos. <a href="https://theexactmatch.com/sell/upload/${escapeHtml(valuation.token)}">Upload them here →</a></p>`
    : `<p>Got your photos! Jeff is reviewing everything now and will follow up with your numbers shortly.</p>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Valuation In Progress — TheExactMatch</title>
<style>body{font-family:sans-serif;background:#F5F0E8;color:#0C1C33;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:3rem;max-width:480px}.box a{color:#C09A5B}</style></head><body>
<div class="box"><h1>Almost there</h1>${message}<p style="margin-top:1rem;font-size:.85rem;color:#4A5568">Questions? Text Jeff at (512) 650-9328.</p></div>
</body></html>`;
}

function sellReportPageHtml(valuation, photosBySlot) {
  const vehicleLabel = [
    valuation.decoded_year || valuation.lead_year, valuation.decoded_make || valuation.lead_make,
    valuation.decoded_model || valuation.lead_model, valuation.decoded_trim || valuation.lead_trim,
  ].filter(Boolean).join(' ');

  let comps = [];        try { comps = JSON.parse(valuation.marketcheck_comps || '[]'); } catch { comps = []; }
  let reasoning = {};     try { reasoning = JSON.parse(valuation.valuation_reasoning || '{}'); } catch { reasoning = {}; }

  const specRows = [
    valuation.vin && ['VIN', valuation.vin],
    valuation.mileage && ['Mileage', `${Number(valuation.mileage).toLocaleString()} mi`],
    (valuation.decoded_engine) && ['Engine', valuation.decoded_engine],
    (valuation.decoded_drivetrain) && ['Drivetrain', valuation.decoded_drivetrain],
    (valuation.decoded_body_type) && ['Body Type', valuation.decoded_body_type],
    valuation.general_condition && ['Self-Reported Condition', valuation.general_condition],
    valuation.accident_history && ['Accident History', `${valuation.accident_history}${valuation.accident_notes ? ' — ' + valuation.accident_notes : ''}`],
    valuation.mechanical_status && ['Mechanical Status', `${valuation.mechanical_status}${valuation.mechanical_notes ? ' — ' + valuation.mechanical_notes : ''}`],
  ].filter(Boolean);

  const valueCard = (label, value, reason) => `
    <div class="value-card">
      <div class="value-label">${escapeHtml(label)}</div>
      <div class="value-amount">${value != null ? '$' + Number(value).toLocaleString() : '—'}</div>
      <div class="value-reasoning">${escapeHtml(reason || '')}</div>
    </div>`;

  const compsHtml = comps.length
    ? comps.map(c => `
      <div class="comp-row">
        <span>${escapeHtml(`${c.build?.year || ''} ${c.build?.make || ''} ${c.build?.model || ''} ${c.build?.trim || ''}`.trim())}</span>
        <span>${c.miles != null ? Number(c.miles).toLocaleString() + ' mi' : '—'}</span>
        <span>${c.price != null ? '$' + Number(c.price).toLocaleString() : '—'}</span>
        <span>${escapeHtml(c.dealer?.name || '')}${c.dealer?.city ? escapeHtml(` (${c.dealer.city}${c.dealer.state ? ', ' + c.dealer.state : ''})`) : ''}</span>
      </div>`).join('')
    : `<div class="comp-row"><span>No comparable active listings were found for this spec/mileage/region.</span></div>`;

  const slotLabel = (key) => (SELL_PHOTO_ALL_SLOTS.find(s => s.key === key) || {}).label || key;
  const photoKeys = Object.keys(photosBySlot).filter(k => photosBySlot[k]?.length);
  const photosHtml = photoKeys.length
    ? photoKeys.map(key => photosBySlot[key].map(url => `
        <div class="photo-tile">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(slotLabel(key))}"/>
          <div class="photo-tile-label">${escapeHtml(slotLabel(key))}</div>
        </div>`).join('')).join('')
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Your Vehicle Valuation — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--navy:#0C1C33;--navy2:#152a4a;--beige:#F5F0E8;--beige2:#EDE7D9;--gold:#C09A5B;--gold2:#D4B47A;--white:#fff;--gray:#4A5568;--border:#DDD8CC;--green:#1A4731}
  body{font-family:'Jost',sans-serif;background:var(--beige);color:var(--navy)}
  header{background:var(--navy);padding:3rem 2rem;text-align:center}
  .eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold2);margin-bottom:.75rem}
  h1{font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.2rem);font-weight:500;color:var(--white)}
  h1 em{font-style:italic;color:var(--gold2)}
  .sub{color:rgba(255,255,255,.55);font-size:.9rem;margin-top:.75rem;font-weight:300}
  .wrap{max-width:1000px;margin:0 auto;padding:3rem 2rem;display:flex;flex-direction:column;gap:2.5rem}
  .card{background:var(--white);border:1px solid var(--border);border-radius:4px;padding:1.75rem}
  .section-title{font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);margin-bottom:1rem}
  .spec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem}
  .spec-row{display:flex;flex-direction:column;gap:.2rem}
  .spec-label{font-size:.68rem;color:var(--gray);text-transform:uppercase;letter-spacing:.05em}
  .spec-value{font-size:.9rem;color:var(--navy);font-weight:500}
  .value-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem}
  .value-card{background:var(--beige);border:1px solid var(--border);border-radius:4px;padding:1.5rem;display:flex;flex-direction:column;gap:.6rem}
  .value-label{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold)}
  .value-amount{font-family:'Playfair Display',serif;font-size:1.9rem;color:var(--navy)}
  .value-reasoning{font-size:.82rem;color:var(--gray);line-height:1.6}
  .footnote{font-size:.75rem;color:var(--gray);font-style:italic}
  .comp-row{display:grid;grid-template-columns:2fr 1fr 1fr 1.5fr;gap:1rem;font-size:.82rem;padding:.6rem 0;border-bottom:1px solid var(--border)}
  .comp-row:last-child{border-bottom:none}
  .photo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem}
  .photo-tile img{width:100%;height:130px;object-fit:cover;border-radius:3px;border:1px solid var(--border);display:block}
  .photo-tile-label{font-size:.7rem;color:var(--gray);margin-top:.4rem;text-align:center}
  .cta-wrap{text-align:center}
  .cta-btn{padding:1rem 2.5rem;background:var(--gold);color:var(--navy);border:none;border-radius:2px;font-family:'Jost',sans-serif;font-weight:700;font-size:.85rem;letter-spacing:.04em;cursor:pointer}
  .cta-btn:disabled{background:var(--green);color:var(--white);cursor:default}
  footer{text-align:center;padding:2rem;font-size:.72rem;color:var(--gray)}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Your Vehicle Valuation</div>
  <h1>Hi ${escapeHtml(valuation.first_name)}, here's <em>your ${escapeHtml(vehicleLabel || 'vehicle')}.</em></h1>
  <div class="sub">Questions? Text Jeff at (512) 650-9328.</div>
</header>
<div class="wrap">
  <div class="card">
    <div class="section-title">Vehicle Summary</div>
    <div class="spec-grid">
      ${specRows.map(([label, value]) => `<div class="spec-row"><span class="spec-label">${escapeHtml(label)}</span><span class="spec-value">${escapeHtml(value)}</span></div>`).join('')}
    </div>
  </div>

  <div>
    <div class="value-grid">
      ${valueCard('Retail Comp Value', valuation.final_retail_value, reasoning.retail)}
      ${valueCard('Trade-In Value', valuation.final_trade_in_value, reasoning.trade_in)}
      ${valueCard('Private-Sale Value', valuation.final_private_sale_value, reasoning.private_sale)}
    </div>
    <p class="footnote" style="margin-top:1rem">Based on self-reported and photo-confirmed information, subject to revision.</p>
  </div>

  <div class="card">
    <div class="section-title">Comparable Listings</div>
    ${compsHtml}
  </div>

  ${photoKeys.length ? `
  <div class="card">
    <div class="section-title">Condition Photos</div>
    <div class="photo-grid">${photosHtml}</div>
  </div>` : ''}

  <div class="cta-wrap">
    <button class="cta-btn" id="ready-btn" ${valuation.ready_to_sell ? 'disabled' : ''} onclick="markReadyToSell('${valuation.token}')">
      ${valuation.ready_to_sell ? "✓ Jeff's on it — expect to hear from him soon" : "Ready to Sell? Let's Talk"}
    </button>
  </div>
</div>
<footer>© ${new Date().getFullYear()} TheExactMatch.com</footer>
<script>
async function markReadyToSell(token) {
  const btn = document.getElementById('ready-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api/public/sell/' + token + '/ready', { method: 'POST' });
    if (res.ok) { btn.textContent = "✓ Jeff's on it — expect to hear from him soon"; }
    else { btn.disabled = false; btn.textContent = "Ready to Sell? Let's Talk"; }
  } catch (e) { btn.disabled = false; btn.textContent = "Ready to Sell? Let's Talk"; }
}
</script>
</body></html>`;
}

async function renderSellReportPage(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*, sell_my_car_leads.first_name,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.token = ?
  `).bind(params.token).first();

  if (!valuation) return htmlResponse(sellNotFoundHtml(), 404);
  if (valuation.status !== 'valued') return htmlResponse(sellReportPendingHtml(valuation));

  const photosBySlot = await fetchPhotosBySlot(env, valuation.id);

  return htmlResponse(sellReportPageHtml(valuation, photosBySlot));
}

async function publicMarkReadyToSell(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.id, vehicle_valuations.ready_to_sell,
      vehicle_valuations.final_retail_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
      sell_my_car_leads.first_name, sell_my_car_leads.last_name, sell_my_car_leads.email, sell_my_car_leads.phone,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make, sell_my_car_leads.model AS lead_model,
      vehicle_valuations.decoded_year, vehicle_valuations.decoded_make, vehicle_valuations.decoded_model
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.token = ?
  `).bind(params.token).first();
  if (!valuation) return json({ error: 'Valuation not found.' }, 404);

  if (!valuation.ready_to_sell) {
    await env.DB.prepare(`UPDATE vehicle_valuations SET ready_to_sell = 1, ready_to_sell_at = datetime('now') WHERE id = ?`).bind(valuation.id).run();

    const vehicleLabel = `${valuation.decoded_year || valuation.lead_year || ''} ${valuation.decoded_make || valuation.lead_make || ''} ${valuation.decoded_model || valuation.lead_model || ''}`.trim();

    await sendBrevoEmail(env, {
      to: 'theexactmatch@gmail.com',
      subject: '🚗 Seller ready to move forward',
      html: brandedEmailHtml(`
        <p><strong>${escapeHtml(valuation.first_name)} ${escapeHtml(valuation.last_name)}</strong> is ready to sell their ${escapeHtml(vehicleLabel)}.</p>
        <p><strong>Values:</strong> Retail ${valuation.final_retail_value ? '$' + Number(valuation.final_retail_value).toLocaleString() : '—'} ·
          Trade-In ${valuation.final_trade_in_value ? '$' + Number(valuation.final_trade_in_value).toLocaleString() : '—'} ·
          Private-Sale ${valuation.final_private_sale_value ? '$' + Number(valuation.final_private_sale_value).toLocaleString() : '—'}</p>
        <p><strong>Contact:</strong><br/>
        Email: <a href="mailto:${escapeHtml(valuation.email)}">${escapeHtml(valuation.email)}</a><br/>
        Phone: ${valuation.phone ? escapeHtml(valuation.phone) : 'not provided'}</p>
        <p><a href="https://theexactmatch.com/Dealerportal.html">View in dashboard →</a></p>
      `),
    });
  }

  return json({ success: true });
}

async function submitSellCarLead(request, env, params, dealer, token, ctx) {
  const body       = await request.json().catch(() => ({}));
  const first_name = (body.first_name || '').trim();
  const last_name  = (body.last_name || '').trim();
  const email      = (body.email || '').trim().toLowerCase();
  const phone      = (body.phone || '').trim();

  if (!first_name || !last_name || !email) return json({ error: 'Name and email are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);

  const year    = parseInt(String(body.year || '').replace(/[^0-9]/g, ''), 10) || null;
  const mileage = parseInt(String(body.mileage || '').replace(/[^0-9]/g, ''), 10) || null;
  const zip     = (body.zip || '').trim();
  const make    = (body.make || '').trim();
  const model   = (body.model || '').trim();
  const trim    = (body.trim || '').trim();
  const vin     = (body.vin || '').trim().toUpperCase() || null;
  const accident_history  = (body.accident_history || '').trim().toLowerCase() || 'none';
  const accident_notes    = (body.accident_notes || '').trim();
  const mechanical_status = (body.mechanical_status || '').trim();
  const mechanical_notes  = (body.mechanical_notes || '').trim();

  const result = await env.DB.prepare(`
    INSERT INTO sell_my_car_leads (
      first_name, last_name, email, phone, zip, year, make, model, trim, mileage, exterior_color,
      title_status, remaining_balance, payoff_amount, condition, accidents, accidents_count, accidents_damage,
      mechanical_issues, mechanical_desc, warning_lights, windshield, tires, modifications, modifications_desc,
      keys, timeline, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    first_name, last_name, email, phone, zip,
    year, make, model, trim,
    mileage, (body.exterior_color || '').trim(),
    body.title_status || '', body.remaining_balance || '', (body.payoff_amount || '').trim(), body.condition || '',
    body.accidents || '', (body.accidents_count || '').trim(), (body.accidents_damage || '').trim(),
    body.mechanical_issues || '', (body.mechanical_desc || '').trim(), body.warning_lights || '',
    body.windshield || '', body.tires || '', body.modifications || '', (body.modifications_desc || '').trim(),
    body.keys || '', body.timeline || '', (body.notes || '').trim()
  ).run();

  const leadId = result.meta.last_row_id;

  if (ctx) {
    ctx.waitUntil(generateValuationForLead(env, leadId, {
      vin, mileage, year, make, model, trim, zip,
      general_condition: body.condition || '',
      accident_history, accident_notes, mechanical_status, mechanical_notes,
    }).catch(err => console.error('valuation pipeline failed for lead', leadId, err)));
  }

  return json({ success: true });
}

async function submitContactMessage(request, env) {
  const body       = await request.json().catch(() => ({}));
  const first_name = (body.first_name || '').trim();
  const last_name  = (body.last_name || '').trim();
  const email      = (body.email || '').trim().toLowerCase();
  const phone      = (body.phone || '').trim();
  const topic      = body.topic || '';
  const message    = (body.message || '').trim();

  if (!first_name || !last_name || !email || !message) return json({ error: 'Name, email, and message are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);

  await env.DB.prepare(
    `INSERT INTO contact_messages (first_name, last_name, email, phone, topic, message) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(first_name, last_name, email, phone, topic, message).run();

  return json({ success: true });
}

async function adminDealers(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, dealership_name, email, role, status, created_at FROM dealers WHERE role != 'admin' ORDER BY created_at DESC`
  ).all();
  return json({ dealers: results });
}

// ── Dealer invites ────────────────────────────────────────────────
async function adminGenerateInvite(request, env) {
  const token = randomHex(24);
  await env.DB.prepare(
    `INSERT INTO dealer_invites (token, status, expires_at) VALUES (?, 'pending', datetime('now', '+72 hours'))`
  ).bind(token).run();
  return json({ success: true, token });
}

async function adminListInvites(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, token, created_at, expires_at, (expires_at < datetime('now')) as expired
     FROM dealer_invites WHERE status = 'pending' ORDER BY created_at DESC`
  ).all();
  return json({ invites: results });
}

async function validateInvite(request, env, params) {
  const invite = await env.DB.prepare(
    `SELECT id, status, (expires_at < datetime('now')) as expired FROM dealer_invites WHERE token = ?`
  ).bind(params.token).first();
  if (!invite) return json({ valid: false, error: 'Invalid invite link.' });
  if (invite.status !== 'pending') return json({ valid: false, error: 'This invite has already been used.' });
  if (invite.expired) return json({ valid: false, error: 'This invite link has expired. Ask Jeff for a new one.' });
  return json({ valid: true });
}

async function dealerSignup(request, env) {
  const body = await request.json().catch(() => ({}));
  const token           = (body.token || '').trim();
  const first_name      = (body.first_name || '').trim();
  const last_name       = (body.last_name || '').trim();
  const dealership_name = (body.dealership_name || '').trim();
  const email           = (body.email || '').trim().toLowerCase();
  const password        = body.password || '';

  if (!token) return json({ error: 'Missing invite token.' }, 400);
  if (!first_name || !last_name || !dealership_name || !email || !password) {
    return json({ error: 'All fields are required.' }, 400);
  }
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

  const invite = await env.DB.prepare(
    `SELECT id, status, (expires_at < datetime('now')) as expired FROM dealer_invites WHERE token = ?`
  ).bind(token).first();
  if (!invite) return json({ error: 'Invalid invite link.' }, 400);
  if (invite.status !== 'pending') return json({ error: 'This invite has already been used.' }, 400);
  if (invite.expired) return json({ error: 'This invite link has expired. Ask Jeff for a new one.' }, 400);

  const existing = await env.DB.prepare('SELECT id FROM dealers WHERE email = ?').bind(email).first();
  if (existing) return json({ error: 'An account with this email already exists.' }, 409);

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const name = `${first_name} ${last_name}`;

  const result = await env.DB.prepare(
    `INSERT INTO dealers (name, dealership_name, email, password_hash, password_salt, role, status)
     VALUES (?, ?, ?, ?, ?, 'dealer', 'active')`
  ).bind(name, dealership_name, email, hash, salt).run();

  const dealerId = result.meta.last_row_id;

  await env.DB.prepare(
    `UPDATE dealer_invites SET status = 'used', used_at = datetime('now'), dealer_id = ? WHERE id = ?`
  ).bind(dealerId, invite.id).run();

  const sessionToken = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO dealer_sessions (id, dealer_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`
  ).bind(sessionToken, dealerId).run();

  return json({
    token: sessionToken,
    dealer: { id: dealerId, name, dealership_name, email, role: 'dealer' },
  });
}

async function adminUpdateDealer(request, env, params) {
  const body = await request.json().catch(() => ({}));
  if (!VALID_DEALER_STATUSES.includes(body.status)) return json({ error: 'Invalid status.' }, 400);
  await env.DB.prepare('UPDATE dealers SET status = ? WHERE id = ?').bind(body.status, +params.id).run();
  return json({ success: true });
}

// ── Vehicle report admin actions ──────────────────────────────────
async function adminListReports(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.last_name, find_car_leads.email,
      (SELECT COUNT(*) FROM report_vehicles WHERE report_vehicles.report_id = find_car_reports.id AND report_vehicles.interested = 1) as interested_count
    FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
    ORDER BY find_car_reports.created_at DESC
  `).all();
  return json({ reports: results });
}

async function adminGetReport(request, env, params) {
  const report = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.last_name, find_car_leads.email
    FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
    WHERE find_car_reports.report_code = ?
  `).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const { results: vehicles } = await env.DB.prepare(
    `SELECT * FROM report_vehicles WHERE report_id = ? ORDER BY position`
  ).bind(report.id).all();

  return json({ report, vehicles });
}

const REPORT_VEHICLE_EDITABLE_FIELDS = [
  'year', 'make', 'model', 'trim', 'rationale', 'price', 'mileage', 'dealer_name', 'dealer_city', 'dealer_state',
  'engine', 'transmission', 'drivetrain', 'city_mpg', 'highway_mpg', 'exterior_color', 'exterior_color_options',
  'safety_rating', 'cargo_space', 'seating_capacity', 'warranty', 'notable_features',
  'source', 'verified',
];

async function adminUpdateReportVehicle(request, env, params) {
  const body = await request.json().catch(() => ({}));
  const report = await env.DB.prepare('SELECT id FROM find_car_reports WHERE report_code = ?').bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const sets = [];
  const values = [];
  for (const field of REPORT_VEHICLE_EDITABLE_FIELDS) {
    if (field in body) { sets.push(`${field} = ?`); values.push(body[field]); }
  }
  if (!sets.length) return json({ error: 'No editable fields provided.' }, 400);

  values.push(report.id, +params.position);
  await env.DB.prepare(`UPDATE report_vehicles SET ${sets.join(', ')} WHERE report_id = ? AND position = ?`).bind(...values).run();
  return json({ success: true });
}

async function adminApproveReport(request, env, params) {
  const report = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.email
    FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
    WHERE find_car_reports.report_code = ?
  `).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);
  if (report.status === 'approved') return json({ error: 'Report already approved.' }, 400);

  await env.DB.prepare(`UPDATE find_car_reports SET status = 'approved', approved_at = datetime('now') WHERE id = ?`).bind(report.id).run();

  await sendBrevoEmail(env, {
    to: report.email,
    subject: 'Your 3 matched vehicles are ready',
    html: `<p>Hi ${escapeHtml(report.first_name)},</p><p>Your curated vehicle options are ready to view:</p>
           <p><a href="https://theexactmatch.com/reports/${escapeHtml(report.report_code)}">View your matches →</a></p>
           <p>Questions? Text Jeff directly at (512) 650-9328.</p>`,
  });

  return json({ success: true });
}

// ── Public hosted report page + client interest ───────────────────
async function adminUploadReportVehiclePhoto(request, env, params) {
  const report = await env.DB.prepare('SELECT id FROM find_car_reports WHERE report_code = ?').bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'No photo file provided.' }, 400);

  const key = `reports/${params.code}/${params.position}`;
  await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'image/jpeg' } });

  const photoUrl = `https://theexactmatch.com/reports/photos/${params.code}/${params.position}`;
  await env.DB.prepare('UPDATE report_vehicles SET photo_url = ? WHERE report_id = ? AND position = ?')
    .bind(photoUrl, report.id, +params.position).run();

  return json({ success: true, photo_url: photoUrl });
}

async function servePhoto(env, params, method) {
  const key = `reports/${params.code}/${params.position}`;
  const object = method === 'HEAD' ? await env.PHOTOS.head(key) : await env.PHOTOS.get(key);
  if (!object) return new Response(method === 'HEAD' ? null : 'Not found', { status: 404 });
  return new Response(method === 'HEAD' ? null : object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  });
}

function sendInterestConfirmationEmail(env, details, deepDiveUrl) {
  const html = brandedEmailHtml(`
    <p>Hey ${escapeHtml(details.first_name)},</p>
    <p>Got it — we've noted your interest in the ${escapeHtml(details.year)} ${escapeHtml(details.make)} ${escapeHtml(details.model)} ${escapeHtml(details.trim)}. Jeff will be in touch shortly to help you take the next step.</p>
    <p><a href="${deepDiveUrl}">See the full details on this vehicle →</a></p>
    <p>— Jeff</p>
  `);
  return sendBrevoEmail(env, {
    to: details.email,
    subject: "We've got your interest — Jeff will be in touch shortly",
    html,
  });
}

async function publicExpressReportInterest(request, env, params) {
  const report = await env.DB.prepare(
    `SELECT id, report_code FROM find_car_reports WHERE report_code = ? AND status = 'approved'`
  ).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const position = +params.position;
  const vehicle = await env.DB.prepare(
    'SELECT id, year, make, model, trim, interested FROM report_vehicles WHERE report_id = ? AND position = ?'
  ).bind(report.id, position).first();
  if (!vehicle) return json({ error: 'Vehicle not found.' }, 404);

  const deepDiveUrl = `https://theexactmatch.com/reports/${report.report_code}-${slugify(`${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`)}`;

  if (!vehicle.interested) {
    await env.DB.prepare(
      `UPDATE report_vehicles SET interested = 1, interested_at = datetime('now') WHERE id = ?`
    ).bind(vehicle.id).run();

    const details = await env.DB.prepare(`
      SELECT find_car_leads.first_name, find_car_leads.last_name, find_car_leads.email, find_car_leads.phone,
        report_vehicles.year, report_vehicles.make, report_vehicles.model, report_vehicles.trim
      FROM report_vehicles
      JOIN find_car_reports ON find_car_reports.id = report_vehicles.report_id
      JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
      WHERE report_vehicles.id = ?
    `).bind(vehicle.id).first();

    await sendBrevoEmail(env, {
      to: 'theexactmatch@gmail.com',
      subject: 'Client expressed interest in a vehicle',
      html: brandedEmailHtml(`
        <p><strong>${escapeHtml(details.first_name)} ${escapeHtml(details.last_name)}</strong> is interested in the
        ${escapeHtml(details.year)} ${escapeHtml(details.make)} ${escapeHtml(details.model)} ${escapeHtml(details.trim)}.</p>
        <p><strong>Contact:</strong><br/>
        Email: <a href="mailto:${escapeHtml(details.email)}">${escapeHtml(details.email)}</a><br/>
        Phone: ${details.phone ? escapeHtml(details.phone) : 'not provided'}</p>
        <p><a href="https://theexactmatch.com/Dealerportal.html">View in dashboard →</a></p>
      `),
    });

    await sendInterestConfirmationEmail(env, details, deepDiveUrl);
  }

  return json({ success: true, deep_dive_url: deepDiveUrl });
}

async function publicReadyToMoveForward(request, env, params) {
  const report = await env.DB.prepare(
    `SELECT id FROM find_car_reports WHERE report_code = ? AND status = 'approved'`
  ).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const position = +params.position;
  const vehicle = await env.DB.prepare(
    'SELECT id, ready FROM report_vehicles WHERE report_id = ? AND position = ?'
  ).bind(report.id, position).first();
  if (!vehicle) return json({ error: 'Vehicle not found.' }, 404);

  if (!vehicle.ready) {
    await env.DB.prepare(
      `UPDATE report_vehicles SET ready = 1, ready_at = datetime('now') WHERE id = ?`
    ).bind(vehicle.id).run();

    const details = await env.DB.prepare(`
      SELECT find_car_leads.first_name, find_car_leads.last_name, find_car_leads.email, find_car_leads.phone,
        report_vehicles.year, report_vehicles.make, report_vehicles.model, report_vehicles.trim
      FROM report_vehicles
      JOIN find_car_reports ON find_car_reports.id = report_vehicles.report_id
      JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
      WHERE report_vehicles.id = ?
    `).bind(vehicle.id).first();

    await sendBrevoEmail(env, {
      to: 'theexactmatch@gmail.com',
      subject: '🚗 Client ready to move forward',
      html: brandedEmailHtml(`
        <p><strong>${escapeHtml(details.first_name)} ${escapeHtml(details.last_name)}</strong> is ready to move forward on the
        ${escapeHtml(details.year)} ${escapeHtml(details.make)} ${escapeHtml(details.model)} ${escapeHtml(details.trim)}.</p>
        <p><strong>Contact:</strong><br/>
        Email: <a href="mailto:${escapeHtml(details.email)}">${escapeHtml(details.email)}</a><br/>
        Phone: ${details.phone ? escapeHtml(details.phone) : 'not provided'}</p>
      `),
    });
  }

  return json({ success: true });
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function reportNotFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Report Not Found — TheExactMatch</title>
<style>body{font-family:sans-serif;background:#F5F0E8;color:#0C1C33;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:3rem;max-width:480px}</style></head><body>
<div class="box"><h1>Report not found</h1><p>This report link is invalid or not yet ready. Contact Jeff at (512) 650-9328 if you think this is a mistake.</p></div>
</body></html>`;
}

function reportPageHtml(report, vehicles) {
  const cards = vehicles.map(v => {
    let features = [];
    try { features = JSON.parse(v.notable_features || '[]'); } catch { features = []; }

    const specRows = [
      v.engine && ['Engine', v.engine],
      v.transmission && ['Transmission', v.transmission],
      v.drivetrain && ['Drivetrain', v.drivetrain],
      (v.city_mpg || v.highway_mpg) && ['Fuel Economy', `${v.city_mpg || '—'} city / ${v.highway_mpg || '—'} hwy MPG`],
      v.exterior_color && ["This Unit's Color", v.exterior_color],
      v.exterior_color_options && ['Color Options', v.exterior_color_options],
      v.cargo_space && ['Cargo Space', v.cargo_space],
      v.seating_capacity && ['Seating', `${v.seating_capacity} passengers`],
      v.safety_rating && ['Safety', v.safety_rating],
      v.warranty && ['Warranty', v.warranty],
    ].filter(Boolean);

    return `
    <div class="vcard">
      ${v.photo_url
        ? `<img src="${escapeHtml(v.photo_url)}" alt="${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}" class="vphoto"/>`
        : `<div class="vphoto vphoto-placeholder"><span>Photo coming soon</span></div>`}
      <div class="vtitle">${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} ${escapeHtml(v.trim)}</div>
      <div class="vmeta">
        ${v.source === 'sourcing_in_progress'
          ? `<span class="pill" style="border-color:var(--gold);color:var(--gold)">Sourcing in progress</span>`
          : `
            ${v.price ? `<span class="pill">$${Number(v.price).toLocaleString()}</span>` : ''}
            ${v.mileage ? `<span class="pill">${Number(v.mileage).toLocaleString()} mi</span>` : ''}
            ${v.dealer_name ? `<span class="pill">${escapeHtml(v.dealer_name)}</span>` : ''}
            ${v.dealer_city ? `<span class="pill">${escapeHtml(v.dealer_city)}${v.dealer_state ? ', ' + escapeHtml(v.dealer_state) : ''}</span>` : ''}
          `}
      </div>
      <div class="vrationale">${escapeHtml(v.rationale)}</div>
      ${specRows.length ? `
        <div class="vspecs">
          ${specRows.map(([label, value]) => `<div class="spec-row"><span class="spec-label">${escapeHtml(label)}</span><span class="spec-value">${escapeHtml(value)}</span></div>`).join('')}
        </div>
      ` : ''}
      ${features.length ? `
        <div class="vfeatures">
          <div class="vfeatures-title">Notable Features</div>
          <ul>${features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
        </div>
      ` : ''}
      <button class="interest-btn" data-position="${v.position}" ${v.interested ? 'disabled' : ''}>
        ${v.interested ? '✓ You expressed interest' : "I'm interested in this one"}
      </button>
    </div>
  `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Your Matches — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--navy:#0C1C33;--navy2:#152a4a;--beige:#F5F0E8;--beige2:#EDE7D9;--gold:#C09A5B;--gold2:#D4B47A;--white:#fff;--gray:#4A5568;--border:#DDD8CC;--green:#1A4731}
  body{font-family:'Jost',sans-serif;background:var(--beige);color:var(--navy)}
  header{background:var(--navy);padding:3rem 2rem;text-align:center}
  .eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold2);margin-bottom:.75rem}
  h1{font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.2rem);font-weight:500;color:var(--white)}
  h1 em{font-style:italic;color:var(--gold2)}
  .sub{color:rgba(255,255,255,.55);font-size:.9rem;margin-top:.75rem;font-weight:300}
  .wrap{max-width:1000px;margin:0 auto;padding:3rem 2rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem}
  .vcard{background:var(--white);border:1px solid var(--border);border-radius:4px;padding:1.75rem;display:flex;flex-direction:column;gap:.85rem}
  .vphoto{width:calc(100% + 3.5rem);height:180px;object-fit:cover;margin:-1.75rem -1.75rem 0;display:block;background:var(--beige2)}
  .vphoto-placeholder{display:flex;align-items:center;justify-content:center;color:var(--gray);font-size:.75rem;font-style:italic}
  .vtitle{font-family:'Playfair Display',serif;font-size:1.1rem;font-weight:500;color:var(--navy)}
  .vmeta{display:flex;flex-wrap:wrap;gap:.4rem}
  .pill{font-size:.68rem;font-weight:500;padding:.25rem .65rem;border:1px solid var(--border);border-radius:20px;color:var(--gray)}
  .vrationale{font-size:.82rem;color:var(--gray);line-height:1.6}
  .vspecs{border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.4rem}
  .spec-row{display:flex;justify-content:space-between;gap:1rem;font-size:.78rem}
  .spec-label{color:var(--gray);flex-shrink:0}
  .spec-value{color:var(--navy);font-weight:500;text-align:right}
  .vfeatures{border-top:1px solid var(--border);padding-top:.85rem}
  .vfeatures-title{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin-bottom:.5rem}
  .vfeatures ul{padding-left:1.1rem;color:var(--gray);font-size:.78rem;line-height:1.6}
  .interest-btn{padding:.75rem;background:var(--gold);color:var(--navy);border:none;border-radius:2px;font-family:'Jost',sans-serif;font-weight:700;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;margin-top:auto}
  .interest-btn:disabled{background:var(--green);color:var(--white);cursor:default}
  footer{text-align:center;padding:2rem;font-size:.72rem;color:var(--gray)}
</style>
</head>
<body>
<header>
  <div class="eyebrow">Your Curated Matches</div>
  <h1>Hi ${escapeHtml(report.first_name)}, here are <em>your 3 options.</em></h1>
  <div class="sub">Report ${escapeHtml(report.report_code)} — questions? Text Jeff at (512) 650-9328.</div>
</header>
<div class="wrap">
  <div class="grid">${cards}</div>
</div>
<footer>© ${new Date().getFullYear()} TheExactMatch.com</footer>
<script>
document.querySelectorAll('.interest-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await fetch('https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api/public/reports/${escapeHtml(report.report_code)}/vehicles/' + btn.dataset.position + '/interest', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        btn.textContent = '✓ You expressed interest';
        if (data.deep_dive_url) {
          const link = document.createElement('a');
          link.href = data.deep_dive_url;
          link.textContent = 'View Full Details →';
          link.style.cssText = 'display:block;margin-top:.6rem;text-align:center;font-size:.72rem;color:var(--gold);text-decoration:none;font-weight:600;letter-spacing:.05em;text-transform:uppercase';
          btn.insertAdjacentElement('afterend', link);
        }
      } else { btn.disabled = false; btn.textContent = "I'm interested in this one"; }
    } catch (e) { btn.disabled = false; btn.textContent = "I'm interested in this one"; }
  });
});
</script>
</body></html>`;
}

function vehicleDeepDiveHtml(report, vehicle) {
  const v = vehicle;
  let features = [];
  try { features = JSON.parse(v.notable_features || '[]'); } catch { features = []; }
  let photos = [];
  try { photos = JSON.parse(v.photo_urls || '[]'); } catch { photos = []; }
  if (!photos.length && v.photo_url) photos = [v.photo_url];

  const specRows = [
    v.engine && ['Engine', v.engine],
    v.transmission && ['Transmission', v.transmission],
    v.drivetrain && ['Drivetrain', v.drivetrain],
    (v.city_mpg || v.highway_mpg) && ['Fuel Economy', `${v.city_mpg || '—'} city / ${v.highway_mpg || '—'} hwy MPG`],
    v.exterior_color && ["This Unit's Color", v.exterior_color],
    v.exterior_color_options && ['Color Options', v.exterior_color_options],
    v.cargo_space && ['Cargo Space', v.cargo_space],
    v.seating_capacity && ['Seating', `${v.seating_capacity} passengers`],
    v.safety_rating && ['Safety', v.safety_rating],
    v.warranty && ['Warranty', v.warranty],
  ].filter(Boolean);

  const gallery = photos.length
    ? photos.map(p => `<img src="${escapeHtml(p)}" alt="${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}" class="gphoto"/>`).join('')
    : `<div class="gphoto gphoto-placeholder"><span>Photo coming soon</span></div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet"/>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--navy:#0C1C33;--navy2:#152a4a;--beige:#F5F0E8;--beige2:#EDE7D9;--gold:#C09A5B;--gold2:#D4B47A;--white:#fff;--gray:#4A5568;--border:#DDD8CC;--green:#1A4731}
  body{font-family:'Jost',sans-serif;background:var(--beige);color:var(--navy)}
  header{background:var(--navy);padding:3rem 2rem;text-align:center}
  .backlink{display:inline-block;color:rgba(255,255,255,.55);font-size:.72rem;text-decoration:none;margin-bottom:1rem;letter-spacing:.03em}
  .eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold2);margin-bottom:.75rem}
  h1{font-family:'Playfair Display',serif;font-size:clamp(1.6rem,3vw,2.2rem);font-weight:500;color:var(--white)}
  h1 em{font-style:italic;color:var(--gold2)}
  .sub{color:rgba(255,255,255,.55);font-size:.9rem;margin-top:.75rem;font-weight:300}
  .wrap{max-width:840px;margin:0 auto;padding:3rem 2rem}
  .card{background:var(--white);border:1px solid var(--border);border-radius:4px;padding:1.75rem;display:flex;flex-direction:column;gap:1.25rem}
  .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.6rem;margin:-1.75rem -1.75rem 0}
  .gallery .gphoto{width:100%;height:220px;object-fit:cover;display:block;background:var(--beige2)}
  .gphoto-placeholder{display:flex;align-items:center;justify-content:center;color:var(--gray);font-size:.8rem;font-style:italic;grid-column:1/-1}
  .vtitle{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:500;color:var(--navy)}
  .vmeta{display:flex;flex-wrap:wrap;gap:.4rem}
  .pill{font-size:.72rem;font-weight:500;padding:.3rem .75rem;border:1px solid var(--border);border-radius:20px;color:var(--gray)}
  .vrationale{font-size:.92rem;color:var(--gray);line-height:1.7}
  .vspecs{border-top:1px solid var(--border);padding-top:1rem;display:flex;flex-direction:column;gap:.5rem}
  .spec-row{display:flex;justify-content:space-between;gap:1rem;font-size:.85rem}
  .spec-label{color:var(--gray);flex-shrink:0}
  .spec-value{color:var(--navy);font-weight:500;text-align:right}
  .vfeatures{border-top:1px solid var(--border);padding-top:1rem}
  .vfeatures-title{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);margin-bottom:.6rem}
  .vfeatures ul{padding-left:1.2rem;color:var(--gray);font-size:.85rem;line-height:1.7}
  .cta-wrap{border-top:1px solid var(--border);padding-top:1.5rem;text-align:center}
  .cta-btn{padding:1rem 2rem;background:var(--gold);color:var(--navy);border:none;border-radius:2px;font-family:'Jost',sans-serif;font-weight:700;font-size:.85rem;letter-spacing:.04em;cursor:pointer;width:100%}
  .cta-btn:disabled{background:var(--green);color:var(--white);cursor:default}
  footer{text-align:center;padding:2rem;font-size:.72rem;color:var(--gray)}
</style>
</head>
<body>
<header>
  <a class="backlink" href="https://theexactmatch.com/reports/${escapeHtml(report.report_code)}">← Back to all your options</a>
  <div class="eyebrow">A Closer Look</div>
  <h1>Hi ${escapeHtml(report.first_name)}, here's your <em>${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}.</em></h1>
  <div class="sub">Report ${escapeHtml(report.report_code)} — questions? Text Jeff at (512) 650-9328.</div>
</header>
<div class="wrap">
  <div class="card">
    <div class="gallery">${gallery}</div>
    <div class="vtitle">${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} ${escapeHtml(v.trim)}</div>
    <div class="vmeta">
      ${v.source === 'sourcing_in_progress'
        ? `<span class="pill" style="border-color:var(--gold);color:var(--gold)">Sourcing in progress</span>`
        : `
          ${v.price ? `<span class="pill">$${Number(v.price).toLocaleString()}</span>` : ''}
          ${v.mileage ? `<span class="pill">${Number(v.mileage).toLocaleString()} mi</span>` : ''}
          ${v.dealer_name ? `<span class="pill">${escapeHtml(v.dealer_name)}</span>` : ''}
          ${v.dealer_city ? `<span class="pill">${escapeHtml(v.dealer_city)}${v.dealer_state ? ', ' + escapeHtml(v.dealer_state) : ''}</span>` : ''}
        `}
    </div>
    <div class="vrationale">${escapeHtml(v.rationale)}</div>
    ${specRows.length ? `
      <div class="vspecs">
        ${specRows.map(([label, value]) => `<div class="spec-row"><span class="spec-label">${escapeHtml(label)}</span><span class="spec-value">${escapeHtml(value)}</span></div>`).join('')}
      </div>
    ` : ''}
    ${features.length ? `
      <div class="vfeatures">
        <div class="vfeatures-title">Notable Features</div>
        <ul>${features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      </div>
    ` : ''}
    <div class="cta-wrap">
      <button class="cta-btn" id="ready-btn" data-position="${v.position}" ${v.ready ? 'disabled' : ''}>
        ${v.ready ? "✓ Jeff's on it — expect to hear from him soon" : 'Ready to move forward? Jeff will take it from here.'}
      </button>
    </div>
  </div>
</div>
<footer>© ${new Date().getFullYear()} TheExactMatch.com</footer>
<script>
document.getElementById('ready-btn').addEventListener('click', async function() {
  const btn = this;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch('https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api/public/reports/${escapeHtml(report.report_code)}/vehicles/' + btn.dataset.position + '/ready', { method: 'POST' });
    if (res.ok) { btn.textContent = "✓ Jeff's on it — expect to hear from him soon"; }
    else { btn.disabled = false; btn.textContent = 'Ready to move forward? Jeff will take it from here.'; }
  } catch (e) { btn.disabled = false; btn.textContent = 'Ready to move forward? Jeff will take it from here.'; }
});
</script>
</body></html>`;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const REPORT_CODE_RE = /^(TEM-\d{4}-\d{4})(?:-(.+))?$/;

async function renderReportPage(request, env, params) {
  const m = (params.code || '').match(REPORT_CODE_RE);
  if (!m) return htmlResponse(reportNotFoundHtml(), 404);
  const [, reportCode, slug] = m;

  const report = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.last_name
    FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
    WHERE find_car_reports.report_code = ?
  `).bind(reportCode).first();

  if (!report || report.status !== 'approved') return htmlResponse(reportNotFoundHtml(), 404);

  const { results: vehicles } = await env.DB.prepare(
    'SELECT * FROM report_vehicles WHERE report_id = ? ORDER BY position'
  ).bind(report.id).all();

  if (slug) {
    const vehicle = vehicles.find(v => slugify(`${v.year} ${v.make} ${v.model} ${v.trim}`) === slug);
    if (!vehicle) return htmlResponse(reportNotFoundHtml(), 404);
    return htmlResponse(vehicleDeepDiveHtml(report, vehicle));
  }

  return htmlResponse(reportPageHtml(report, vehicles));
}

// ── Route table ───────────────────────────────────────────────────
const ROUTES = [
  { method: 'POST',  pattern: '/api/setup/init-admin',          handler: initAdmin },
  { method: 'POST',  pattern: '/api/dealer/login',               handler: dealerLogin },
  { method: 'POST',  pattern: '/api/dealer/logout',               handler: dealerLogout, auth: true },
  { method: 'GET',   pattern: '/api/dealer/me',                   handler: dealerMe, auth: true },
  { method: 'POST',  pattern: '/api/dealer/submit-vehicle',       handler: submitVehicle, auth: true },
  { method: 'GET',   pattern: '/api/dealer/leads',                 handler: dealerLeads, auth: true },
  { method: 'GET',   pattern: '/api/dealer/leads/:id/valuation',   handler: dealerGetLeadValuation, auth: true },
  { method: 'POST',  pattern: '/api/dealer/leads/:id/interest',   handler: expressInterest, auth: true },
  { method: 'GET',   pattern: '/api/dealer/my-submissions',       handler: mySubmissions, auth: true },
  { method: 'GET',   pattern: '/api/admin/submissions',           handler: adminSubmissions, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/submissions/:id',       handler: adminUpdateSubmission, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/leads',                 handler: adminLeads, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/leads/:id/valuation',    handler: adminGetLeadValuation, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/leads/:id/valuation/photo/:slot', handler: adminUploadValuationPhoto, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/find-leads',             handler: adminFindLeads, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/contact-messages',       handler: adminContactMessages, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/public/find-car-lead',         handler: submitFindCarLead },
  { method: 'POST',  pattern: '/api/public/sell-car-lead',         handler: submitSellCarLead },
  { method: 'POST',  pattern: '/api/public/sell/:token/photo/:slot', handler: uploadSellPhoto },
  { method: 'POST',  pattern: '/api/public/sell/:token/complete',    handler: completeSellPhotos },
  { method: 'POST',  pattern: '/api/public/sell/:token/ready',       handler: publicMarkReadyToSell },
  { method: 'POST',  pattern: '/api/public/contact-message',       handler: submitContactMessage },
  { method: 'GET',   pattern: '/api/admin/dealers',               handler: adminDealers, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/dealers/:id',           handler: adminUpdateDealer, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/invites',                handler: adminGenerateInvite, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/invites',                handler: adminListInvites, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/dealer/invites/:token',        handler: validateInvite },
  { method: 'POST',  pattern: '/api/dealer/signup',                handler: dealerSignup },
  { method: 'GET',   pattern: '/api/admin/reports',                     handler: adminListReports, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/reports/:code',                handler: adminGetReport, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/reports/:code/vehicles/:position', handler: adminUpdateReportVehicle, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/approve',        handler: adminApproveReport, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/vehicles/:position/photo', handler: adminUploadReportVehiclePhoto, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/vehicles/:position/scrape-listing', handler: adminScrapeListingUrl, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/interest', handler: publicExpressReportInterest },
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/ready', handler: publicReadyToMoveForward },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);

    if (request.method === 'GET' || request.method === 'HEAD') {
      const photoParams = matchPath('/reports/photos/:code/:position', url.pathname);
      if (photoParams) return servePhoto(env, photoParams, request.method);

      const sellPhotoParams = matchPath('/sell/photos/:token/:slot/:filename', url.pathname);
      if (sellPhotoParams) return serveSellPhoto(env, sellPhotoParams, request.method);
    }

    if (request.method === 'GET') {
      const reportParams = matchPath('/reports/:code', url.pathname);
      if (reportParams) return renderReportPage(request, env, reportParams);

      const sellUploadParams = matchPath('/sell/upload/:token', url.pathname);
      if (sellUploadParams) return renderSellUploadPage(request, env, sellUploadParams);

      const sellReportParams = matchPath('/sell/report/:token', url.pathname);
      if (sellReportParams) return renderSellReportPage(request, env, sellReportParams);
    }

    for (const route of ROUTES) {
      if (request.method !== route.method) continue;
      const params = matchPath(route.pattern, url.pathname);
      if (!params) continue;

      let dealer = null;
      let token  = null;

      if (route.auth) {
        const authHeader = request.headers.get('Authorization') || '';
        const m = authHeader.match(/^Bearer (.+)$/);
        token = m ? m[1] : null;
        if (!token) return json({ error: 'Not authenticated.' }, 401);

        dealer = await authenticate(token, env);
        if (!dealer) return json({ error: 'Session expired. Please log in again.' }, 401);
        if (route.admin && dealer.role !== 'admin') return json({ error: 'Admin access required.' }, 403);
      }

      try {
        return await route.handler(request, env, params, dealer, token, ctx);
      } catch (err) {
        return json({ error: 'Server error. Please try again.' }, 500);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};
