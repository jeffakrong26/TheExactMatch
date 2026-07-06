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
async function submitFindCarLead(request, env) {
  const body        = await request.json().catch(() => ({}));
  const first_name  = (body.first_name || '').trim();
  const last_name   = (body.last_name || '').trim();
  const email       = (body.email || '').trim().toLowerCase();
  const phone       = (body.phone || '').trim();

  if (!first_name || !last_name || !email) return json({ error: 'Name and email are required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);

  await env.DB.prepare(`
    INSERT INTO find_car_leads (
      first_name, last_name, email, phone, zip, vehicle_type, size_preference, condition,
      budget_min, budget_max, timeline, priorities, current_vehicle, current_like, current_change,
      trade_in, specific_needs, considering, anything_else
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    first_name, last_name, email, phone,
    (body.zip || '').trim(), body.vehicle_type || '', body.size_preference || '', body.condition || '',
    (body.budget_min || '').toString().trim(), (body.budget_max || '').toString().trim(), body.timeline || '', body.priorities || '',
    (body.current_vehicle || '').trim(), (body.current_like || '').trim(), (body.current_change || '').trim(),
    body.trade_in || '', (body.specific_needs || '').trim(), (body.considering || '').trim(), (body.anything_else || '').trim()
  ).run();

  return json({ success: true });
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
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);

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
        return await route.handler(request, env, params, dealer, token);
      } catch (err) {
        return json({ error: 'Server error. Please try again.' }, 500);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};
