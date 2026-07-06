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
    `SELECT id, year, make, model, mileage, condition, title_status, city, state, notes, created_at,
       EXISTS(SELECT 1 FROM lead_interest WHERE lead_id = sell_my_car_leads.id AND dealer_id = ?) as i_expressed_interest
     FROM sell_my_car_leads ORDER BY created_at DESC`
  ).bind(dealer.id).all();

  return json({ leads: results.map(l => ({ ...l, i_expressed_interest: !!l.i_expressed_interest })) });
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
      GROUP_CONCAT(dealers.dealership_name) as interested_dealers
    FROM sell_my_car_leads
    LEFT JOIN lead_interest ON lead_interest.lead_id = sell_my_car_leads.id
    LEFT JOIN dealers ON dealers.id = lead_interest.dealer_id
    GROUP BY sell_my_car_leads.id
    ORDER BY sell_my_car_leads.created_at DESC
  `).all();
  return json({ leads: results });
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
  return `A car-buying client filled out our "Find My Car" form. Based on their answers, recommend exactly 3 specific vehicles (year, make, model, trim) that best fit their needs. For each, give a short rationale tied to their stated priorities and situation.

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
              rationale: { type: 'string', description: 'Why this fits their budget, priorities, and situation' },
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

async function searchMarketcheck(env, { make, model, zip }) {
  for (const radius of MARKETCHECK_RADII) {
    const url = new URL('https://api.marketcheck.com/v2/search/car/active');
    url.searchParams.set('api_key', env.MARKETCHECK_API_KEY);
    url.searchParams.set('zip', zip || '78701');
    url.searchParams.set('radius', String(radius));
    url.searchParams.set('make', make);
    if (model) url.searchParams.set('model', model);
    url.searchParams.set('rows', model ? '5' : '1');

    const res = await fetch(url.toString());
    if (!res.ok) continue;
    const data = await res.json().catch(() => ({}));
    if (data.listings && data.listings.length) return { listings: data.listings, radius };
  }
  return null;
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
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      tools: [tool], tool_choice: { type: 'tool', name: 'record_vehicle_specs' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.stop_reason === 'refusal') return {};
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : {};
}

async function findFranchiseFallback(env, { make, zip }) {
  const found = await searchMarketcheck(env, { make, model: null, zip });
  if (!found) return null;
  const l = found.listings[0];
  return {
    dealer_name: l.dealer?.name || null,
    dealer_city: l.dealer?.city || null,
    dealer_state: l.dealer?.state || null,
    price: null, mileage: null, vdp_url: null, photo_url: null,
    source: 'franchise_fallback', verified: 'fallback',
  };
}

async function processVehiclePick(env, pick, lead) {
  const found = await searchMarketcheck(env, { make: pick.make, model: pick.model, zip: lead.zip });
  let entry;
  if (found) {
    const l = found.listings[0];
    entry = {
      ...pick,
      price: l.price ?? null,
      mileage: l.miles ?? null,
      dealer_name: l.dealer?.name || null,
      dealer_city: l.dealer?.city || null,
      dealer_state: l.dealer?.state || null,
      vdp_url: l.vdp_url || null,
      source: 'marketcheck',
      verified: await verifyListingLive(l.vdp_url),
      engine: l.build?.engine || null,
      transmission: l.build?.transmission || null,
      drivetrain: l.build?.drivetrain || null,
      city_mpg: l.build?.city_mpg ?? null,
      highway_mpg: l.build?.highway_mpg ?? null,
      exterior_color: l.exterior_color || null,
      photo_url: l.media?.photo_links_cached?.[0] || l.media?.photo_links?.[0] || null,
    };
  } else {
    const fallback = await findFranchiseFallback(env, { make: pick.make, zip: lead.zip });
    entry = { ...pick, ...(fallback || { price: null, mileage: null, dealer_name: null, dealer_city: null, dealer_state: null, vdp_url: null, photo_url: null, source: 'none', verified: 'unverified' }) };
  }

  const specs = await enrichVehicleSpecs(env, pick, { engine: entry.engine, transmission: entry.transmission, drivetrain: entry.drivetrain });
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

  return entry;
}

async function generateReportForLead(env, leadId) {
  const lead = await env.DB.prepare('SELECT * FROM find_car_leads WHERE id = ?').bind(leadId).first();
  if (!lead) return;

  const picks = await pickVehicles(env, lead);
  const vehicles = await Promise.all(picks.map(pick => processVehiclePick(env, pick, lead)));

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
        safety_rating, cargo_space, seating_capacity, warranty, notable_features, photo_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId, i + 1, v.year, v.make, v.model, v.trim, v.rationale,
      v.price, v.mileage, v.dealer_name, v.dealer_city, v.dealer_state, v.vdp_url, v.source, v.verified,
      v.engine, v.transmission, v.drivetrain, v.city_mpg, v.highway_mpg, v.exterior_color, v.exterior_color_options,
      v.safety_rating, v.cargo_space, v.seating_capacity, v.warranty, v.notable_features, v.photo_url
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
            ${v.vdp_url
              ? `<a href="${escapeHtml(v.vdp_url)}">View listing →</a> (${escapeHtml(v.verified)})`
              : `no direct link — ${escapeHtml(v.source)}, dealer: ${escapeHtml(v.dealer_name || 'unknown')}`}
          </li>
        `).join('')}
      </ul>
      <p><a href="https://theexactmatch.com/Dealerportal.html">Review &amp; approve in dashboard →</a></p>
    `),
  });
}

async function submitSellCarLead(request, env) {
  const body       = await request.json().catch(() => ({}));
  const first_name = (body.first_name || '').trim();
  const last_name  = (body.last_name || '').trim();
  const email      = (body.email || '').trim().toLowerCase();
  const phone      = (body.phone || '').trim();

  if (!first_name || !last_name || !email) return json({ error: 'Name and email are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);

  const year    = parseInt(String(body.year || '').replace(/[^0-9]/g, ''), 10) || null;
  const mileage = parseInt(String(body.mileage || '').replace(/[^0-9]/g, ''), 10) || null;

  await env.DB.prepare(`
    INSERT INTO sell_my_car_leads (
      first_name, last_name, email, phone, zip, year, make, model, trim, mileage, exterior_color,
      title_status, remaining_balance, payoff_amount, condition, accidents, accidents_count, accidents_damage,
      mechanical_issues, mechanical_desc, warning_lights, windshield, tires, modifications, modifications_desc,
      keys, timeline, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    first_name, last_name, email, phone, (body.zip || '').trim(),
    year, (body.make || '').trim(), (body.model || '').trim(), (body.trim || '').trim(),
    mileage, (body.exterior_color || '').trim(),
    body.title_status || '', body.remaining_balance || '', (body.payoff_amount || '').trim(), body.condition || '',
    body.accidents || '', (body.accidents_count || '').trim(), (body.accidents_damage || '').trim(),
    body.mechanical_issues || '', (body.mechanical_desc || '').trim(), body.warning_lights || '',
    body.windshield || '', body.tires || '', body.modifications || '', (body.modifications_desc || '').trim(),
    body.keys || '', body.timeline || '', (body.notes || '').trim()
  ).run();

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

async function servePhoto(env, params) {
  const key = `reports/${params.code}/${params.position}`;
  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  });
}

async function publicExpressReportInterest(request, env, params) {
  const report = await env.DB.prepare(
    `SELECT id FROM find_car_reports WHERE report_code = ? AND status = 'approved'`
  ).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const position = +params.position;
  const vehicle = await env.DB.prepare(
    'SELECT id, interested FROM report_vehicles WHERE report_id = ? AND position = ?'
  ).bind(report.id, position).first();
  if (!vehicle) return json({ error: 'Vehicle not found.' }, 404);

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
        ${v.price ? `<span class="pill">$${Number(v.price).toLocaleString()}</span>` : ''}
        ${v.mileage ? `<span class="pill">${Number(v.mileage).toLocaleString()} mi</span>` : ''}
        ${v.dealer_name ? `<span class="pill">${escapeHtml(v.dealer_name)}</span>` : ''}
        ${v.dealer_city ? `<span class="pill">${escapeHtml(v.dealer_city)}${v.dealer_state ? ', ' + escapeHtml(v.dealer_state) : ''}</span>` : ''}
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
      if (res.ok) { btn.textContent = '✓ You expressed interest'; }
      else { btn.disabled = false; btn.textContent = "I'm interested in this one"; }
    } catch (e) { btn.disabled = false; btn.textContent = "I'm interested in this one"; }
  });
});
</script>
</body></html>`;
}

async function renderReportPage(request, env, params) {
  const report = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.last_name
    FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
    WHERE find_car_reports.report_code = ?
  `).bind(params.code).first();

  if (!report || report.status !== 'approved') return htmlResponse(reportNotFoundHtml(), 404);

  const { results: vehicles } = await env.DB.prepare(
    'SELECT * FROM report_vehicles WHERE report_id = ? ORDER BY position'
  ).bind(report.id).all();

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
  { method: 'POST',  pattern: '/api/dealer/leads/:id/interest',   handler: expressInterest, auth: true },
  { method: 'GET',   pattern: '/api/dealer/my-submissions',       handler: mySubmissions, auth: true },
  { method: 'GET',   pattern: '/api/admin/submissions',           handler: adminSubmissions, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/submissions/:id',       handler: adminUpdateSubmission, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/leads',                 handler: adminLeads, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/find-leads',             handler: adminFindLeads, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/contact-messages',       handler: adminContactMessages, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/public/find-car-lead',         handler: submitFindCarLead },
  { method: 'POST',  pattern: '/api/public/sell-car-lead',         handler: submitSellCarLead },
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
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/interest', handler: publicExpressReportInterest },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);

    if (request.method === 'GET') {
      const photoParams = matchPath('/reports/photos/:code/:position', url.pathname);
      if (photoParams) return servePhoto(env, photoParams);

      const reportParams = matchPath('/reports/:code', url.pathname);
      if (reportParams) return renderReportPage(request, env, reportParams);
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
