// ── TheExactMatch Dealer Portal API ──────────────────────────────
// Cloudflare Worker + D1 (dealer-portal database). Bearer-token sessions,
// PBKDF2 password hashing.

// US ZIP (ZCTA) -> [lat, lng] centroids, from the Census Bureau's public-domain
// 2024 Gazetteer file. Used to compute distance from a client's zip to a
// listing's coordinates without any extra geocoding API call. PO-box-only
// zips (e.g. 77001) have no ZCTA and won't be in this table.
import ZIP_CENTROIDS from './zip-centroids.json';

function zipCentroid(zip) {
  return ZIP_CENTROIDS[(zip || '').trim()] || null;
}

function haversineMiles([lat1, lng1], [lat2, lng2]) {
  const R = 3958.8; // Earth radius in miles
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEALER_WELCOME_TEMPLATE_ID = 7; // Brevo "Dealer Welcome — Portal Invite Accepted"

// Accepts "smithmotors.com" or "https://smithmotors.com" and normalizes to a
// full URL. Returns { url: null, error } if the input isn't a plausible website.
function normalizeWebsiteUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { url: null, error: null };
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes('.')) return { url: null, error: 'Please enter a valid dealership website.' };
    return { url: u.toString(), error: null };
  } catch {
    return { url: null, error: 'Please enter a valid dealership website.' };
  }
}
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
// Newsletter submissions reuse the exact schema.org → Claude-fallback
// extraction pipeline built for Find My Car's manual listing entry
// (adminScrapeListingUrl) instead of trusting dealer-typed spec fields —
// same reasoning as the report-accuracy fix: a listing URL is the source
// of truth, free-text is descriptive color only.
async function submitVehicle(request, env, params, dealer) {
  const body = await request.json().catch(() => ({}));
  const listingUrl = (body.listing_url || '').trim();
  const category = body.category;
  const notes = (body.description || '').trim();

  if (!/^https?:\/\//i.test(listingUrl)) return json({ error: 'Please paste a full listing URL.' }, 400);
  if (!category) return json({ error: 'Category is required.' }, 400);

  let html;
  try {
    const res = await fetch(listingUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheExactMatchBot/1.0)' } });
    if (!res.ok) return json({ error: `Could not fetch that page (HTTP ${res.status}). Double-check the URL.` }, 400);
    html = await res.text();
  } catch {
    return json({ error: 'Could not fetch that page. Double-check the URL.' }, 400);
  }

  const structuredData = extractJsonLdVehicle(html);
  const ogData = extractOgTags(html);
  let photos = extractPhotosFromPage(structuredData, ogData);
  if (!photos.length) photos = extractGenericImageGallery(html, listingUrl);
  const structuredFields = extractStructuredVehicleFields(structuredData);
  const extracted = await extractListingWithClaude(env, html, structuredFields, ogData);
  const genericSpecs = extractGenericSpecLabelValues(cleanHtmlText(html));

  const hasAnyData = extracted.found_confidence !== 'none' || Object.values(structuredFields).some(v => v != null);
  if (!hasAnyData) return json({ error: "That page doesn't look like a vehicle listing. Double-check the URL." }, 400);

  const year = structuredFields.year ?? extracted.year ?? null;
  const make = structuredFields.make || extracted.make || null;
  const model = structuredFields.model || extracted.model || null;
  if (!year || !make || !model) {
    console.error('submitVehicle: failed to extract year/make/model', listingUrl, JSON.stringify({ structuredFields, extracted, ogTitle: ogData?.title }));
    return json({ error: "Couldn't determine year/make/model from that listing. Try a different URL or contact us directly." }, 400);
  }

  const trim = extracted.trim || null;
  const mileage = structuredFields.mileage ?? extracted.mileage ?? null;
  const price = structuredFields.price ?? extracted.price ?? null;
  const exteriorColor = structuredFields.color || genericSpecs.exterior_color || extracted.color || null;
  const engine = structuredFields.engine || genericSpecs.engine || extracted.engine || null;
  const transmission = structuredFields.transmission || genericSpecs.transmission || extracted.transmission || null;

  const writeUp = await generateSubmissionWriteUp(env, {
    year, make, model, trim, price, mileage, exterior_color: exteriorColor, engine, transmission, category,
  });

  const result = await env.DB.prepare(`
    INSERT INTO inventory_submissions (
      dealer_id, year, make, model, trim, mileage, asking_price, vin, exterior_color, engine, transmission,
      category, description, write_up, listing_url, photo_url, image_urls, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).bind(
    dealer.id, year, make, model, trim, mileage, price,
    structuredFields.vin || genericSpecs.vin || extracted.vin || null,
    exteriorColor, engine, transmission,
    category, notes, writeUp, listingUrl, photos[0] || null, JSON.stringify(photos)
  ).run();

  return json({ success: true, id: result.meta.last_row_id, confidence: extracted.found_confidence });
}

async function dealerLeads(request, env, params, dealer) {
  const { results } = await env.DB.prepare(
    `SELECT sell_my_car_leads.id, sell_my_car_leads.year, sell_my_car_leads.make, sell_my_car_leads.model,
       sell_my_car_leads.mileage, sell_my_car_leads.condition, sell_my_car_leads.title_status,
       sell_my_car_leads.city, sell_my_car_leads.state, sell_my_car_leads.notes, sell_my_car_leads.created_at,
       vehicle_valuations.status as valuation_status, vehicle_valuations.vin as valuation_vin,
       vehicle_valuations.final_retail_value, vehicle_valuations.final_cash_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
       vehicle_valuations.photo_confirmed, vehicle_valuations.low_confidence,
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
      sell_my_car_leads.exterior_color, sell_my_car_leads.title_status AS lead_title_status
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.lead_id = ?
  `).bind(+params.id).first();
  if (!valuation) return json({ error: 'No valuation found for this lead yet.' }, 404);
  const photos = await fetchPhotosBySlot(env, valuation.id);
  return json({ valuation: { ...valuation, photo_confirmed: !!valuation.photo_confirmed, low_confidence: !!valuation.low_confidence }, photos });
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
    `SELECT id, year, make, model, trim, mileage, asking_price AS price, vin, exterior_color, engine, transmission,
            category, description, write_up, listing_url, photo_url, image_urls, status, created_at
     FROM inventory_submissions WHERE dealer_id = ? ORDER BY created_at DESC`
  ).bind(dealer.id).all();
  return json({ submissions: results });
}

// ── Admin actions ─────────────────────────────────────────────────
async function adminSubmissions(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT inventory_submissions.id, inventory_submissions.year, inventory_submissions.make, inventory_submissions.model,
            inventory_submissions.trim, inventory_submissions.mileage, inventory_submissions.asking_price AS price,
            inventory_submissions.vin, inventory_submissions.exterior_color, inventory_submissions.engine,
            inventory_submissions.transmission, inventory_submissions.category, inventory_submissions.description,
            inventory_submissions.write_up, inventory_submissions.listing_url, inventory_submissions.photo_url,
            inventory_submissions.image_urls, inventory_submissions.status, inventory_submissions.created_at,
            dealers.name as dealer_name, dealers.dealership_name
     FROM inventory_submissions JOIN dealers ON dealers.id = inventory_submissions.dealer_id
     ORDER BY inventory_submissions.created_at DESC`
  ).all();
  return json({ submissions: results });
}

const SUBMISSION_EDITABLE_FIELDS = [
  'year', 'make', 'model', 'trim', 'mileage', 'asking_price', 'vin', 'exterior_color',
  'engine', 'transmission', 'category', 'description', 'write_up', 'listing_url',
];

async function adminUpdateSubmission(request, env, params) {
  const body = await request.json().catch(() => ({}));

  const sets = [];
  const values = [];
  for (const field of SUBMISSION_EDITABLE_FIELDS) {
    if (field in body) { sets.push(`${field} = ?`); values.push(body[field]); }
  }
  if ('status' in body) {
    if (!VALID_SUB_STATUSES.includes(body.status)) return json({ error: 'Invalid status.' }, 400);
    sets.push('status = ?'); values.push(body.status);
  }
  if (!sets.length) return json({ error: 'No editable fields provided.' }, 400);

  values.push(+params.id);
  await env.DB.prepare(`UPDATE inventory_submissions SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ success: true });
}

async function adminDeleteSubmission(request, env, params) {
  await env.DB.prepare('DELETE FROM inventory_submissions WHERE id = ?').bind(+params.id).run();
  return json({ success: true });
}

// Same fetch + schema.org/OG/Claude-fallback pipeline as adminScrapeListingUrl
// (Find My Car), applied to a newsletter submission that's missing (or has
// a wrong) listing URL — lets admin backfill one on an existing submission
// instead of only being able to set it at dealer-submit time.
async function adminScrapeSubmissionListing(request, env, params) {
  const submission = await env.DB.prepare('SELECT * FROM inventory_submissions WHERE id = ?').bind(+params.id).first();
  if (!submission) return json({ error: 'Submission not found.' }, 404);

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
  let photos = extractPhotosFromPage(structuredData, ogData);
  if (!photos.length) photos = extractGenericImageGallery(html, url);
  const structuredFields = extractStructuredVehicleFields(structuredData);
  const extracted = await extractListingWithClaude(env, html, structuredFields, ogData);
  const genericSpecs = extractGenericSpecLabelValues(cleanHtmlText(html));

  const hasAnyData = extracted.found_confidence !== 'none' || Object.values(structuredFields).some(v => v != null);
  if (!hasAnyData) return json({ error: "That page doesn't look like a vehicle listing. Fill in the fields below manually." });

  const merged = {
    year: structuredFields.year ?? extracted.year ?? submission.year,
    make: structuredFields.make || extracted.make || submission.make,
    model: structuredFields.model || extracted.model || submission.model,
    trim: extracted.trim || submission.trim,
    price: structuredFields.price ?? extracted.price ?? submission.asking_price,
    mileage: structuredFields.mileage ?? extracted.mileage ?? submission.mileage,
    vin: structuredFields.vin || genericSpecs.vin || extracted.vin || submission.vin,
    exterior_color: structuredFields.color || genericSpecs.exterior_color || extracted.color || submission.exterior_color,
    engine: structuredFields.engine || genericSpecs.engine || extracted.engine || submission.engine,
    transmission: structuredFields.transmission || genericSpecs.transmission || extracted.transmission || submission.transmission,
    photo_url: photos[0] || submission.photo_url,
    image_urls: JSON.stringify(photos.length ? photos : JSON.parse(submission.image_urls || '[]')),
  };

  const writeUp = await generateSubmissionWriteUp(env, { ...merged, category: submission.category }) || submission.write_up;

  await env.DB.prepare(`
    UPDATE inventory_submissions SET year=?, make=?, model=?, trim=?, asking_price=?, mileage=?, vin=?, exterior_color=?,
      engine=?, transmission=?, photo_url=?, image_urls=?, listing_url=?, write_up=? WHERE id=?
  `).bind(merged.year, merged.make, merged.model, merged.trim, merged.price, merged.mileage, merged.vin, merged.exterior_color,
    merged.engine, merged.transmission, merged.photo_url, merged.image_urls, url, writeUp, submission.id).run();

  return json({ success: true, confidence: extracted.found_confidence });
}

// Manual fallback for when extraction can't find any photo on the listing
// page (no schema.org image, no og:image) — same R2-backed pattern as
// adminUploadReportVehiclePhoto for Find My Car.
async function adminUploadSubmissionPhoto(request, env, params) {
  const submission = await env.DB.prepare('SELECT * FROM inventory_submissions WHERE id = ?').bind(+params.id).first();
  if (!submission) return json({ error: 'Submission not found.' }, 404);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('photo');
  if (!file || typeof file === 'string') return json({ error: 'No photo file provided.' }, 400);

  const key = `submissions/${params.id}`;
  await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'image/jpeg' } });

  const photoUrl = `https://theexactmatch.com/submissions/photos/${params.id}`;
  let photos = [];
  try { photos = JSON.parse(submission.image_urls || '[]'); } catch { photos = []; }
  if (!photos.includes(photoUrl)) photos.unshift(photoUrl);

  await env.DB.prepare('UPDATE inventory_submissions SET photo_url = ?, image_urls = ? WHERE id = ?')
    .bind(photoUrl, JSON.stringify(photos), +params.id).run();

  return json({ success: true, photo_url: photoUrl });
}

async function serveSubmissionPhoto(env, params, method) {
  const key = `submissions/${params.id}`;
  const object = method === 'HEAD' ? await env.PHOTOS.head(key) : await env.PHOTOS.get(key);
  if (!object) return new Response(method === 'HEAD' ? null : 'Not found', { status: 404 });
  return new Response(method === 'HEAD' ? null : object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
  });
}

async function adminLeads(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT sell_my_car_leads.*,
      COUNT(lead_interest.dealer_id) as interest_count,
      GROUP_CONCAT(dealers.dealership_name) as interested_dealers,
      vehicle_valuations.status as valuation_status,
      vehicle_valuations.vin as valuation_vin,
      vehicle_valuations.final_retail_value, vehicle_valuations.final_cash_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
      vehicle_valuations.photo_confirmed, vehicle_valuations.low_confidence, vehicle_valuations.manually_adjusted,
      (SELECT url FROM valuation_photos WHERE valuation_id = vehicle_valuations.id AND slot = 'front_34' LIMIT 1) as front_photo_url
    FROM sell_my_car_leads
    LEFT JOIN lead_interest ON lead_interest.lead_id = sell_my_car_leads.id
    LEFT JOIN dealers ON dealers.id = lead_interest.dealer_id
    LEFT JOIN vehicle_valuations ON vehicle_valuations.lead_id = sell_my_car_leads.id
    GROUP BY sell_my_car_leads.id
    ORDER BY sell_my_car_leads.created_at DESC
  `).all();
  return json({ leads: results.map(l => ({ ...l, photo_confirmed: !!l.photo_confirmed, low_confidence: !!l.low_confidence, manually_adjusted: !!l.manually_adjusted })) });
}

async function deleteSellCarLead(env, leadId) {
  const valuation = await env.DB.prepare('SELECT id, token FROM vehicle_valuations WHERE lead_id = ?').bind(leadId).first();
  if (valuation) {
    const { results: photos } = await env.DB.prepare('SELECT slot, url FROM valuation_photos WHERE valuation_id = ?').bind(valuation.id).all();
    for (const photo of photos) {
      const filename = photo.url.split('/').pop();
      await env.PHOTOS.delete(`sell/${valuation.token}/${photo.slot}/${filename}`).catch(() => {});
    }
    await env.DB.prepare('DELETE FROM valuation_photos WHERE valuation_id = ?').bind(valuation.id).run();
    await env.DB.prepare('DELETE FROM vehicle_valuations WHERE id = ?').bind(valuation.id).run();
  }
  await env.DB.prepare('DELETE FROM lead_interest WHERE lead_id = ?').bind(leadId).run();
  await env.DB.prepare('DELETE FROM sell_my_car_leads WHERE id = ?').bind(leadId).run();
}

async function adminDeleteLead(request, env, params) {
  await deleteSellCarLead(env, +params.id);
  return json({ success: true });
}

async function adminGetLeadValuation(request, env, params) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*,
      sell_my_car_leads.first_name, sell_my_car_leads.last_name, sell_my_car_leads.email, sell_my_car_leads.phone,
      sell_my_car_leads.zip, sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim,
      sell_my_car_leads.exterior_color, sell_my_car_leads.title_status AS lead_title_status
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.lead_id = ?
  `).bind(+params.id).first();
  if (!valuation) return json({ error: 'No valuation found for this lead yet.' }, 404);
  const photos = await fetchPhotosBySlot(env, valuation.id);
  return json({
    valuation: { ...valuation, photo_confirmed: !!valuation.photo_confirmed, low_confidence: !!valuation.low_confidence, manually_adjusted: !!valuation.manually_adjusted },
    photos,
  });
}

async function adminFindLeads(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM find_car_leads ORDER BY created_at DESC`
  ).all();
  return json({ leads: results });
}

async function adminContactMessages(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT contact_messages.*,
      EXISTS(SELECT 1 FROM admin_seen_items WHERE section = 'messages' AND item_id = contact_messages.id) as seen
    FROM contact_messages ORDER BY created_at DESC
  `).all();
  return json({ messages: results.map(m => ({ ...m, seen: !!m.seen })) });
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
    // The report pipeline (Claude + Auto.dev, multiple round trips) can run
    // long enough to hit the hard 30s ctx.waitUntil() ceiling for HTTP-triggered
    // Workers, which silently kills the job with no trace. Queue consumers get
    // their own execution budget instead, so hand it off rather than run it inline.
    ctx.waitUntil(env.JOB_QUEUE.send({ type: 'find_car_report', leadId }).catch(err => console.error('failed to enqueue report job for lead', leadId, err)));

    // Sequential, not two parallel waitUntil calls — the touch-log call needs the
    // deal to already exist, and parallel calls have no ordering guarantee, which
    // let this 404 silently and drop the confirmation-email log entry.
    ctx.waitUntil((async () => {
      try {
        await notifyCrm(env, '/api/hooks/lead-created', {
          funnel_type: 'find_my_car', source_lead_id: leadId,
          first_name, last_name, email, phone,
          current_vehicle: (body.current_vehicle || '').trim() || null,
          vehicle_description: [body.vehicle_type, body.size_preference].filter(Boolean).join(' · ') || null,
          budget_min: body.budget_min || null, budget_max: body.budget_max || null, credit_range: body.credit_range || null,
          trade_in: body.trade_in && !/^no$/i.test(String(body.trade_in).trim()) ? 1 : 0,
        });
        await notifyCrm(env, '/api/hooks/log-touch', {
          funnel_type: 'find_my_car', source_lead_id: leadId, type: 'confirmation_email',
        });
      } catch (err) {
        console.error('CRM hook failed', leadId, err);
      }
    })());
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

async function sendBrevoTemplateEmail(env, { to, templateId, params }) {
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body: JSON.stringify({
        to: [{ email: to }],
        templateId,
        params,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Brevo template email rejected', res.status, body);
    }
  } catch (err) {
    console.error('Brevo template email failed', err);
  }
}

// ── CRM notification hooks ─────────────────────────────────────────
// Fire-and-forget calls into the standalone CRM Worker so it can track leads
// and log milestone emails. Every call site wraps this in ctx.waitUntil(...).catch(...)
// (or a plain .catch() inside a queue consumer) — a CRM outage or bug here must
// never affect the live Find My Car / Sell My Car pipeline.
async function notifyCrm(env, path, body) {
  const res = await fetch(env.CRM_HOOK_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hook-Secret': env.CRM_HOOK_SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`CRM hook ${path} returned ${res.status}: ${errBody}`);
  }
}

function buildVehiclePrompt(lead) {
  const year = new Date().getFullYear();
  const consideringSpecificModel = (lead.considering || '').trim().length > 0;
  return `A car-buying client filled out our "Find My Car" form. Based on their answers, recommend exactly 3 specific vehicles (year, make, model, trim) that best fit their needs. For each, write a short rationale addressed DIRECTLY to the client in second person — always "you"/"your", never "they"/"their"/"the client"/"the buyer". For example: "This fits your need for extra cargo space" — not "This fits their need for extra cargo space."

${consideringSpecificModel
  ? `The client already told us the specific make/model they want: "${lead.considering}". All 3 recommendations MUST be that exact make and model — vary them by year, trim, or configuration only. Do not substitute a different make/model, even a similar one, unless what they wrote isn't a real, buildable vehicle.`
  : `The client did not name a specific make/model, so use the rest of their answers (vehicle type, priorities, budget, etc.) to recommend the 3 best-fitting vehicles — these may span different makes/models.`}

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

  if (!res.ok) throw new Error(`Claude API error (recommendations): HTTP ${res.status}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the recommendation request');
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block: ' + JSON.stringify(data));
  const vehicles = toolUse.input.vehicles || [];
  if (vehicles.length !== 3) throw new Error(`Expected 3 vehicles, got ${vehicles.length}: ` + JSON.stringify(vehicles));
  return vehicles;
}

// ── Find My Car: Auto.dev vehicle listings + photos ──────────────
// Replaces Marketcheck for sourcing real inventory (below). Sell My Car's
// separate valuation pipeline (VIN decode + comps, further down this file)
// still uses Marketcheck independently — not part of this migration.
const AUTODEV_BASE_URL = 'https://api.auto.dev';

// NOTE: listings calls deliberately do NOT use ?select=. retailListing.dealerId
// — required for safe partner-dealer matching — silently returns null under
// ?select= no matter the field path (confirmed live, several variants tried).
// Full nested objects cost more payload but that's not what the free tier
// meters; call count is, and this doesn't add any calls.

// Shared wrapper for every Auto.dev call: Bearer auth, one retry after a 1s
// wait on 429 (free tier is 5 req/s), and a row in autodev_api_log so
// monthly usage can be tracked against the 1,000-call/month free tier.
async function autodevFetch(env, path, params, { leadId } = {}) {
  const url = new URL(AUTODEV_BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  const doFetch = () => fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${env.AUTODEV_API_KEY}`, 'Content-Type': 'application/json' },
  });

  let res = await doFetch();
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 1000));
    res = await doFetch();
  }

  const data = await res.json().catch(() => null);
  const resultCount = Array.isArray(data?.data) ? data.data.length
    : Array.isArray(data?.data?.retail) ? data.data.retail.length
    : null;

  try {
    await env.DB.prepare(
      `INSERT INTO autodev_api_log (endpoint, params, status_code, result_count, lead_id) VALUES (?, ?, ?, ?, ?)`
    ).bind(path, JSON.stringify(params || {}), res.status, resultCount, leadId ?? null).run();
  } catch (err) {
    console.error('autodev_api_log insert failed', err);
  }

  return { ok: res.ok, status: res.status, data };
}

// Auto.dev returns [lng, lat] (GeoJSON order). [0, 0] means the listing's
// location never resolved — treat it as unknown distance, not "at the
// equator/prime meridian".
function autodevListingDistance(clientCentroid, location) {
  if (!clientCentroid || !Array.isArray(location) || location.length !== 2) return null;
  const [lng, lat] = location;
  if (lat === 0 && lng === 0) return null;
  return haversineMiles(clientCentroid, [lat, lng]);
}

// Some Auto.dev listings (confirmed live — regional/superstore dealers like
// EchoPark and Avis Car Sales especially) carry a synthetic "#1234..."
// fragment in retailListing.vdp instead of a real link.
function isValidVdpUrl(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

// Maps one full (non-select) listing object to the shape the rest of the
// pipeline expects. Field names verified against a live Auto.dev response,
// not assumed from docs alone.
function mapAutodevListing(raw, distanceMiles) {
  const v = raw.vehicle || {};
  const r = raw.retailListing || {};
  return {
    vin: v.vin || raw.vin || null,
    year: v.year ?? null,
    make: v.make || null,
    model: v.model || null,
    trim: v.trim || null,
    drivetrain: v.drivetrain || null,
    transmission: v.transmission || null,
    engine: v.engine || null,
    exterior_color: v.exteriorColor || null,
    price: r.price ?? null,
    mileage: r.miles ?? null,
    dealer_name: r.dealer || null,
    autodev_dealer_id: r.dealerId || null,
    dealer_city: r.city || null,
    dealer_state: r.state || null,
    vdp_url: r.vdp || null,
    primary_image: r.primaryImage || null,
    photo_count: r.photoCount ?? null,
    distance_miles: distanceMiles,
  };
}

// Caps how many partner-dealer-scoped supplementary searches fire per
// searchAutodevListings call, so partner count growth can't blow up the
// per-report call budget.
const MAX_PARTNER_INVENTORY_SEARCHES = 3;

// Auto.dev has no exact dealerId filter (confirmed: 400 "Invalid parameter"
// on retailListing.dealerId) — only a dealer NAME filter, and that name
// isn't unique (confirmed live: two unrelated dealers both named "Audi
// North Austin", one of them selling unrelated used inventory). So this
// searches by name, then discards anything whose returned dealerId doesn't
// match the one captured for this partner via the admin lookup route,
// rather than trusting the name match alone.
async function searchAutodevPartnerInventory(env, dealer, { make, model, yearMin, yearMax, priceMax, used, zip, leadId, clientCentroid }) {
  const params = {
    'retailListing.dealer': dealer.dealership_name,
    'vehicle.make': make || undefined,
    'vehicle.model': model || undefined,
    'vehicle.year': (yearMin && yearMax) ? `${yearMin}-${yearMax}` : undefined,
    'retailListing.price': priceMax ? `0-${Math.round(Number(priceMax))}` : undefined,
    'retailListing.used': used === true ? 'true' : (used === false ? 'false' : undefined),
    zip: zip || undefined,
    limit: 20,
  };
  const { ok, data } = await autodevFetch(env, '/listings', params, { leadId });
  if (!ok || !Array.isArray(data?.data)) return [];
  return data.data
    .map(raw => mapAutodevListing(raw, autodevListingDistance(clientCentroid, raw.location)))
    .filter(l => l.autodev_dealer_id === dealer.autodev_dealer_id && isValidVdpUrl(l.vdp_url));
}

// Single call at 100mi; if empty, exactly one fallback call at 300mi — no
// radius ladder, no pool-size threshold. Sorted by distance from the
// client's zip in-Worker, since Auto.dev doesn't support distance sort
// server-side (confirmed in docs).
async function searchAutodevListings(env, { make, model, trim, zip, yearMin, yearMax, priceMax, used, leadId, partnerDealers }) {
  const clientCentroid = zipCentroid(zip);

  const baseParams = {
    'vehicle.make': make || undefined,
    'vehicle.model': model || undefined,
    'vehicle.year': (yearMin && yearMax) ? `${yearMin}-${yearMax}` : undefined,
    'retailListing.price': priceMax ? `0-${Math.round(Number(priceMax))}` : undefined,
    'retailListing.used': used === true ? 'true' : (used === false ? 'false' : undefined),
    zip: zip || undefined,
    limit: 50,
  };

  async function callAt(distance) {
    const { ok, status, data } = await autodevFetch(env, '/listings', { ...baseParams, distance }, { leadId });
    return { ok, status, listings: (ok && Array.isArray(data?.data)) ? data.data : [] };
  }

  let radius = 100;
  let result = await callAt(radius);
  let usedFallback = false;
  if (result.ok && result.listings.length === 0) {
    radius = 300;
    result = await callAt(radius);
    usedFallback = true;
  }

  // A meaningful share of Auto.dev listings (regional/superstore dealers in
  // particular — EchoPark, Avis Car Sales) carry a synthetic "#1234..."
  // fragment in retailListing.vdp instead of a real URL. A candidate we can't
  // link the client to isn't usable inventory, so it's filtered out here
  // rather than surfaced with a dead link.
  let mapped = result.listings
    .map(raw => mapAutodevListing(raw, autodevListingDistance(clientCentroid, raw.location)))
    .filter(l => isValidVdpUrl(l.vdp_url));
  if (trim) {
    const trimFiltered = mapped.filter(l => trimMatches(l.trim, trim, l.model, model));
    if (trimFiltered.length) mapped = trimFiltered;
  }

  // Dedicated per-partner-dealer search, merged in before the general sort
  // so partner inventory is guaranteed to be considered even if it wouldn't
  // otherwise surface in the general 100/300mi pool (e.g. a partner dealer
  // just outside the general search's candidate cutoff). Capped and
  // deduped by VIN against what the general search already found.
  if (partnerDealers?.length) {
    const existingVins = new Set(mapped.map(l => l.vin).filter(Boolean));
    const partnerBatches = await Promise.all(
      partnerDealers.slice(0, MAX_PARTNER_INVENTORY_SEARCHES).map(d =>
        searchAutodevPartnerInventory(env, d, { make, model, yearMin, yearMax, priceMax, used, zip, leadId, clientCentroid })
      )
    );
    for (const batch of partnerBatches) {
      for (const l of batch) {
        if (l.vin && existingVins.has(l.vin)) continue;
        if (l.vin) existingVins.add(l.vin);
        mapped.push(l);
      }
    }
  }

  mapped.sort((a, b) => {
    if (a.distance_miles == null && b.distance_miles == null) return 0;
    if (a.distance_miles == null) return 1;
    if (b.distance_miles == null) return -1;
    return a.distance_miles - b.distance_miles;
  });

  // Partner dealers rank first (exact dealerId match), distance-sorted
  // within each group since the partition preserves whatever order it
  // received.
  if (partnerDealers?.length) mapped = partitionByPartnerDealer(mapped, partnerDealers);

  return { listings: mapped, radius, usedFallback, ok: result.ok, status: result.status };
}

// Called only for the 3 finalist vehicles, never the full candidate pools.
// Sequential with a ~250ms stagger after the first call (not Promise.all) so
// a single report generation, combined with its listings calls, stays well
// under the 5 req/s free-tier limit. Never fails the pipeline — an empty
// photo array just flags the vehicle for Jeff to source images manually.
async function fetchAutodevPhotos(env, vin, { leadId, staggerMs = 0 } = {}) {
  if (!vin) return { photos: [], photosMissing: true };
  if (staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));

  const { ok, data } = await autodevFetch(env, `/photos/${encodeURIComponent(vin)}`, {}, { leadId });
  const retail = ok ? (data?.data?.retail || []) : [];
  return { photos: retail, photosMissing: retail.length === 0 };
}

async function fetchFinalistPhotos(env, finalists, leadId) {
  const out = [];
  for (let i = 0; i < finalists.length; i++) {
    out.push(await fetchAutodevPhotos(env, finalists[i]?.vin, { leadId, staggerMs: i === 0 ? 0 : 250 }));
  }
  return out;
}

// TEMPORARY admin-only route to run a real end-to-end Auto.dev search +
// finalist-photo call and inspect the raw response mapping before the new
// pipeline is wired into generateReportForLead. Remove once the migration
// is confirmed and shipped.
async function debugAutodevTest(request, env) {
  const url = new URL(request.url);
  const make = url.searchParams.get('make') || 'Mazda';
  const model = url.searchParams.get('model') || 'CX-5';
  const zip = url.searchParams.get('zip') || '77002';
  const yearMin = url.searchParams.get('yearMin') ? +url.searchParams.get('yearMin') : undefined;
  const yearMax = url.searchParams.get('yearMax') ? +url.searchParams.get('yearMax') : undefined;
  const priceMax = url.searchParams.get('priceMax') ? +url.searchParams.get('priceMax') : undefined;
  const used = url.searchParams.get('used') === 'false' ? false : true;
  const finalistCount = Math.min(3, +(url.searchParams.get('finalists') || 3));

  const search = await searchAutodevListings(env, { make, model, zip, yearMin, yearMax, priceMax, used, leadId: null });

  const finalists = search.listings.filter(l => l.vin).slice(0, finalistCount);
  const photos = await fetchFinalistPhotos(env, finalists, null);

  return json({
    query: { make, model, zip, yearMin, yearMax, priceMax, used },
    client_zip_centroid: zipCentroid(zip),
    radius_used: search.radius,
    used_300mi_fallback: search.usedFallback,
    total_candidates_returned: search.listings.length,
    top_10_by_distance: search.listings.slice(0, 10),
    finalists: finalists.map((f, i) => ({ ...f, photos: photos[i].photos, photos_missing: photos[i].photosMissing })),
  });
}

// 200mi/300mi both 422 on our Marketcheck plan (radius cap is plan-dependent —
// confirmed via search_log: 100mi returns 200 OK with 0 results, 200mi+ is
// rejected outright). Keep this at or below whatever the account's plan allows.
const MARKETCHECK_RADII = [25, 50, 100];

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

// Claude recommends vehicles by their manufacturer marketing name, but
// Marketcheck's own model taxonomy sometimes drops generation/performance
// prefixes (verified live against the API — e.g. "718 Cayman" returns 0
// results while "Cayman" returns real inventory). Only entries confirmed
// against live Marketcheck data belong here.
const MARKETCHECK_MODEL_ALIASES = {
  'gr supra': 'Supra',
  '718 cayman': 'Cayman',
  '718 boxster': 'Boxster',
  'tt rs': 'TT',
};

function normalizeModelForMarketcheck(model) {
  const key = (model || '').toLowerCase().trim();
  return MARKETCHECK_MODEL_ALIASES[key] || model;
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

// Only dealers with a captured Auto.dev dealerId (set once by an admin via
// the autodev-lookup route) are usable for matching. Auto.dev's dealer NAME
// is not unique — confirmed live, two unrelated dealers both named "Audi
// North Austin" — so name/website matching risks crediting the wrong lot's
// inventory to a partner. Exact dealerId is the only safe signal.
async function loadPartnerDealers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, dealership_name, autodev_dealer_id FROM dealers
     WHERE role != 'admin' AND status = 'active' AND autodev_dealer_id IS NOT NULL AND autodev_dealer_id != ''`
  ).all();
  return results;
}

// Splits listings into ones sold by a registered partner dealer (exact
// autodev_dealer_id match only) vs. everything else. Partner listings are
// returned first so they're prioritized without a second Auto.dev query.
function partitionByPartnerDealer(listings, partnerDealers) {
  const byId = new Map();
  for (const d of partnerDealers) {
    if (d.autodev_dealer_id) byId.set(d.autodev_dealer_id, d);
  }

  const partner = [];
  const other = [];
  for (const l of listings) {
    const match = l.autodev_dealer_id && byId.get(l.autodev_dealer_id);
    if (match) partner.push({ ...l, partner_dealer_id: match.id });
    else other.push(l);
  }
  return partner.length ? [...partner, ...other] : listings;
}

async function verifyListingLive(vdpUrl) {
  if (!vdpUrl) return 'unverified';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // Auto.dev's real links are frequently CloudFront-fronted aggregators
    // (autolist.com, vast.com) that 403 a request with no/non-browser
    // User-Agent — confirmed live. A realistic UA is required for this
    // check to mean anything against that traffic.
    const res = await fetch(vdpUrl, {
      method: 'HEAD', redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    });
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

// schema.org Vehicle markup gives exact, machine-readable values — pull these
// directly instead of asking Claude to re-derive them from a truncated JSON
// dump (the "description" field alone commonly runs several thousand
// characters of marketing bullet points and was pushing price/image past any
// reasonable prompt slice).
function extractStructuredVehicleFields(structuredData) {
  if (!structuredData) return {};
  const offers = Array.isArray(structuredData.offers) ? structuredData.offers[0] : structuredData.offers;
  const engine = structuredData.vehicleEngine;
  const year = parseInt(structuredData.vehicleModelDate || structuredData.productionDate, 10);
  const price = offers?.price != null ? Math.round(Number(offers.price)) : null;
  const mileage = structuredData.mileageFromOdometer?.value != null ? Math.round(Number(structuredData.mileageFromOdometer.value)) : null;
  return {
    year: Number.isFinite(year) ? year : null,
    make: structuredData.manufacturer?.name || structuredData.brand?.name || null,
    model: structuredData.model || null,
    price: Number.isFinite(price) ? price : null,
    mileage: Number.isFinite(mileage) ? mileage : null,
    color: structuredData.color || null,
    engine: typeof engine === 'string' ? engine : (engine?.name || null),
    transmission: structuredData.vehicleTransmission || null,
    drivetrain: structuredData.driveWheelConfiguration || null,
    vin: structuredData.vehicleIdentificationNumber || null,
  };
}

function cleanHtmlText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fallback for dealer sites with no og:image/schema.org photos at all (common
// on small WordPress/Bricks-builder dealer sites) — scans every <img> tag's
// srcset for its widest variant, dedupes same photo at different resolutions
// (WordPress suffixes each size as "-300x200.jpg" etc.), and filters out
// branding assets (logos/icons/favicons) by filename keyword.
const GENERIC_IMAGE_EXCLUDE_RE = /logo|icon|favicon|sprite|avatar|badge|placeholder|watermark|spinner|loading|banner-ad/i;

function extractGenericImageGallery(html, baseUrl) {
  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const candidates = new Map();

  for (const tag of imgTags) {
    const srcsetMatch = tag.match(/\bsrcset=["']([^"']+)["']/i);
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    let bestUrl = null, bestWidth = 0;

    if (srcsetMatch) {
      for (const part of srcsetMatch[1].split(',')) {
        const [url, descriptor] = part.trim().split(/\s+/);
        const w = parseInt((descriptor || '').replace('w', ''), 10) || 0;
        if (url && w >= bestWidth) { bestWidth = w; bestUrl = url; }
      }
    }
    if (!bestUrl && srcMatch) bestUrl = srcMatch[1];
    if (!bestUrl) continue;

    let absolute;
    try { absolute = new URL(bestUrl, baseUrl).toString(); } catch { continue; }
    if (GENERIC_IMAGE_EXCLUDE_RE.test(absolute)) continue;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(absolute)) continue;

    const key = absolute.replace(/-\d+x\d+(?=\.\w+(\?|$))/, '').split('?')[0];
    const existing = candidates.get(key);
    if (!existing || bestWidth > existing.width) candidates.set(key, { url: absolute, width: bestWidth });
  }

  return [...candidates.values()].sort((a, b) => b.width - a.width).map(c => c.url).slice(0, 12);
}

// Fallback for fields Claude sometimes skips despite them being present in
// the page text (seen on a real dealer's site: "Transmission DCT ... Engine
// Size 3.5L ... Exterior Color Rhapsody Blue ... VIN ..." went unfilled).
// Dealer spec tables collapse to flattened "Label Value Label Value ..."
// text once tags are stripped, so bounding each label's value at wherever
// the next known label starts is a deterministic way to pull it out.
const GENERIC_SPEC_LABELS = [
  { field: 'transmission', pattern: /Transmission/i },
  { field: 'drivetrain', pattern: /Drive\s*Type|Drivetrain/i },
  { field: 'engine', pattern: /Engine(?:\s*Size)?/i },
  { field: 'exterior_color', pattern: /Exterior\s*Color/i },
  { field: 'interior_color', pattern: /Interior\s*Color/i },
  { field: 'vin', pattern: /\bVIN\b/i },
  { field: 'mileage', pattern: /Mileage/i },
  { field: 'fuel_type', pattern: /Fuel\s*Type/i },
  { field: 'cylinders', pattern: /Cylinders/i },
  { field: 'doors', pattern: /\bDoors\b/i },
  { field: 'stock_number', pattern: /Stock\s*#?/i },
];

function extractGenericSpecLabelValues(cleanedText) {
  const matches = [];
  for (const { field, pattern } of GENERIC_SPEC_LABELS) {
    const m = cleanedText.match(pattern);
    if (m && m.index != null) matches.push({ field, start: m.index, end: m.index + m[0].length });
  }
  matches.sort((a, b) => a.start - b.start);

  const result = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : Math.min(cur.end + 80, cleanedText.length);
    const value = cleanedText.slice(cur.end, nextStart).trim().replace(/^[:\-]\s*/, '');
    if (value) result[cur.field] = value;
  }

  // VIN has no reliable "next label" to bound it when it's the last spec
  // field on the page (bleeds into the listing description otherwise) — a
  // VIN has a fixed, checkable shape, so match that directly instead.
  if (result.vin) {
    const vinMatch = result.vin.match(/[A-HJ-NPR-Z0-9]{17}/i);
    result.vin = vinMatch ? vinMatch[0] : null;
    if (!result.vin) delete result.vin;
  }

  return result;
}

async function extractListingWithClaude(env, html, structuredFields, ogData) {
  const cleaned = cleanHtmlText(html).slice(0, 12000);

  const tool = {
    name: 'record_listing_data',
    description: 'Record vehicle listing details extracted from a dealer webpage.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer' }, make: { type: 'string' }, model: { type: 'string' },
        trim: { type: 'string', description: 'The trim/edition name only, e.g. "Premium", "S", "Limited" — usually the last word(s) of the page title after year/make/model. Empty string if truly not stated anywhere.' },
        price: { type: 'integer' }, mileage: { type: 'integer' }, color: { type: 'string' },
        engine: { type: 'string' }, transmission: { type: 'string' }, drivetrain: { type: 'string' },
        vin: { type: 'string', description: '17-character VIN if shown anywhere on the page. Empty string if not stated.' },
        found_confidence: { type: 'string', enum: ['high', 'low', 'none'], description: 'none if this page does not look like a vehicle listing at all' },
      },
      // year/make/model are required (not just optional-but-hoped-for):
      // observed in production against a real listing whose page title
      // plainly read "2020 Ford GT Carbon Series" — Claude intermittently
      // returned only {trim, found_confidence: "high"} and silently
      // dropped year/make/model, apparently reasoning they were already
      // "covered" by the title context. Forcing them required stops that.
      required: ['year', 'make', 'model', 'found_confidence', 'trim'],
      additionalProperties: false,
    },
  };

  const knownFields = Object.fromEntries(Object.entries(structuredFields || {}).filter(([, v]) => v != null && v !== ''));
  const hasKnownFields = Object.keys(knownFields).length > 0;

  const prompt = `Extract vehicle listing details from this dealer webpage content.
${hasKnownFields ? `\nThese fields were already reliably extracted from the page's own structured data — repeat them back as-is, do not second-guess or omit them: ${JSON.stringify(knownFields)}` : ''}
${ogData?.title ? `\nPage title: ${ogData.title}` : ''}

Fill in any fields not already listed above (especially trim, which usually only appears in the page title or text, e.g. "Premium" in "2024 Toyota GR86 Premium") using the page text below. Only omit a field if it's genuinely not determinable from the title or page text.

Page text content:
${cleaned}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, tools: [tool], tool_choice: { type: 'tool', name: 'record_listing_data' }, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) return { found_confidence: 'none' };
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { found_confidence: 'none' };
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : { found_confidence: 'none' };
}

// Auto-generated marketing copy for a newsletter submission — same role as
// Find My Car's per-vehicle rationale: descriptive copy generated FROM the
// extracted spec data, never a source of spec values itself. Stored
// separately from the dealer's own optional typed notes.
async function generateSubmissionWriteUp(env, vehicle) {
  const details = [
    `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`.replace(/\s+/g, ' ').trim(),
    vehicle.price ? `Price: $${Number(vehicle.price).toLocaleString()}` : null,
    vehicle.mileage != null ? `Mileage: ${Number(vehicle.mileage).toLocaleString()} miles` : null,
    vehicle.exterior_color ? `Color: ${vehicle.exterior_color}` : null,
    vehicle.engine ? `Engine: ${vehicle.engine}` : null,
    vehicle.transmission ? `Transmission: ${vehicle.transmission}` : null,
    vehicle.category ? `Category: ${vehicle.category}` : null,
  ].filter(Boolean).join('\n');

  const tool = {
    name: 'record_write_up',
    description: 'Record a short marketing write-up for a newsletter vehicle listing.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        write_up: { type: 'string', description: '2-3 sentence engaging write-up for a car-buyer newsletter audience, using only the facts given. No preamble — just the write-up text.' },
      },
      required: ['write_up'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 300,
      tools: [tool], tool_choice: { type: 'tool', name: 'record_write_up' },
      messages: [{ role: 'user', content: `Write a short, engaging marketing write-up for this vehicle for a "Weekly Finds" car-buyer newsletter. Only use the facts given below — do not invent details.\n\n${details}` }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.stop_reason === 'refusal') return null;
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse?.input?.write_up || null;
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
  let photos = extractPhotosFromPage(structuredData, ogData);
  if (!photos.length) photos = extractGenericImageGallery(html, url);
  const structuredFields = extractStructuredVehicleFields(structuredData);
  const extracted = await extractListingWithClaude(env, html, structuredFields, ogData);
  const genericSpecs = extractGenericSpecLabelValues(cleanHtmlText(html));

  const hasAnyData = extracted.found_confidence !== 'none' || Object.values(structuredFields).some(v => v != null);
  if (!hasAnyData) {
    return json({ error: "That page doesn't look like a vehicle listing. Fill in the fields below manually." });
  }

  const merged = {
    year: structuredFields.year ?? extracted.year ?? existing.year,
    make: structuredFields.make || extracted.make || existing.make,
    model: structuredFields.model || extracted.model || existing.model,
    trim: extracted.trim || existing.trim,
    price: structuredFields.price ?? extracted.price ?? existing.price,
    mileage: structuredFields.mileage ?? extracted.mileage ?? existing.mileage,
    exterior_color: structuredFields.color || genericSpecs.exterior_color || extracted.color || existing.exterior_color,
    engine: structuredFields.engine || genericSpecs.engine || extracted.engine || existing.engine,
    transmission: structuredFields.transmission || genericSpecs.transmission || extracted.transmission || existing.transmission,
    drivetrain: structuredFields.drivetrain || genericSpecs.drivetrain || extracted.drivetrain || existing.drivetrain,
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
  if (!res.ok) return {};
  const data = await res.json();
  if (data.stop_reason === 'refusal') return {};
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : {};
}

// Only filters on used/new when the lead's free-text condition field is
// unambiguous ("used", "new") — anything else (empty, "either", "doesn't
// matter", unrecognized phrasing) applies no filter, matching prior behavior
// exactly rather than risk over-filtering a real lead's search to zero results.
function leadUsedFilter(condition) {
  const c = (condition || '').toLowerCase();
  const hasNew = c.includes('new');
  const hasUsed = c.includes('used');
  if (hasNew && !hasUsed) return false;
  if (hasUsed && !hasNew) return true;
  return undefined;
}

// Fetches the candidate pool for one vehicle pick (already distance-ranked,
// partner dealers first, by searchAutodevListings). Doesn't pick a winner or
// verify anything — that happens after all 3 positions' pools are in hand,
// so positions can be deduped against each other instead of independently
// grabbing the same top listing.
async function fetchListingPool(env, pick, lead, partnerDealers, tag) {
  const t0 = Date.now();
  const searchResult = await searchAutodevListings(env, {
    make: pick.make, model: pick.model, trim: pick.trim, zip: lead.zip,
    yearMin: pick.year ? pick.year - 2 : undefined,
    yearMax: pick.year ? pick.year + 2 : undefined,
    priceMax: lead.budget_max, used: leadUsedFilter(lead.condition),
    leadId: lead.id, partnerDealers,
  });
  console.log(`[timing] ${tag} primary search: ${Date.now() - t0}ms, pool_size=${searchResult.listings?.length || 0}`);
  return { searchResult };
}

function listingVin(l) {
  return l?.vin || null;
}

async function buildVehicleEntry(env, pick, winner, poolInfo, photos, lead, partnerDealers, tag) {
  const { searchResult } = poolInfo;

  // A winner without a source URL can't be shown to the client or verified
  // by admin against the original listing — route it to manual review
  // instead of silently presenting it as a confirmed match. (searchAutodevListings
  // already drops candidates with an unusable vdp_url, so this is really just
  // a defensive check at this point.)
  if (winner && winner.vdp_url) {
    const tVerify = Date.now();
    const verified = await verifyListingLive(winner.vdp_url);
    console.log(`[timing] ${tag} verify: ${Date.now() - tVerify}ms`);
    return {
      ...pick,
      // Claude's pick only ever picks the search target — once a specific
      // listing is matched, every spec value must come from that listing's
      // own record, never from Claude's original guess. (A matched listing
      // can legitimately be a different model year than the pick, since
      // searchAutodevListings queries year ± 2.)
      year: winner.year ?? pick.year,
      make: winner.make || pick.make,
      model: winner.model || pick.model,
      trim: winner.trim || pick.trim,
      price: winner.price ?? null,
      mileage: winner.mileage ?? null,
      dealer_name: winner.dealer_name || null,
      dealer_city: winner.dealer_city || null,
      dealer_state: winner.dealer_state || null,
      vdp_url: winner.vdp_url || null,
      source: 'autodev',
      verified,
      engine: winner.engine || null,
      transmission: winner.transmission || null,
      drivetrain: winner.drivetrain || null,
      city_mpg: null, highway_mpg: null, // not in Auto.dev's schema — filled by enrichVehicleSpecs
      exterior_color: winner.exterior_color || null,
      photo_url: photos?.photos?.[0] || null,
      photo_urls: JSON.stringify(photos?.photos || []),
      photos_missing: photos?.photosMissing ? 1 : 0,
      search_log: JSON.stringify({ radius: searchResult.radius, used_300mi_fallback: searchResult.usedFallback }),
    };
  }

  // No unclaimed candidate for this position (pool empty, or every candidate
  // was already claimed by another position in this report) — franchise
  // fallback, same as before: a make-only search just to find the nearest
  // dealer to show the admin.
  const tFallback = Date.now();
  const franchiseResult = await searchAutodevListings(env, {
    make: pick.make, zip: lead.zip, used: leadUsedFilter(lead.condition), leadId: lead.id, partnerDealers,
  });
  console.log(`[timing] ${tag} franchise fallback: ${Date.now() - tFallback}ms`);
  const nearestDealer = franchiseResult.listings?.[0] || null;
  return {
    ...pick,
    price: null, mileage: null, vdp_url: null, photo_url: null, photo_urls: '[]', photos_missing: 1,
    dealer_name: nearestDealer?.dealer_name || null,
    dealer_city: nearestDealer?.dealer_city || null,
    dealer_state: nearestDealer?.dealer_state || null,
    engine: null, transmission: null, drivetrain: null,
    city_mpg: null, highway_mpg: null, exterior_color: null,
    source: 'sourcing_in_progress',
    verified: 'sourcing_in_progress',
    search_log: JSON.stringify({
      radius: searchResult.radius, used_300mi_fallback: searchResult.usedFallback,
      franchise_radius: franchiseResult.radius, franchise_used_300mi_fallback: franchiseResult.usedFallback,
    }),
  };
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
  const partnerDealers = await loadPartnerDealers(env);
  const tVehicles = Date.now();
  const tags = picks.map(pick => `${pick.year} ${pick.make} ${pick.model}`);

  // Phase A (parallel I/O): fetch each position's candidate pool.
  const pools = await Promise.all(picks.map((pick, i) => fetchListingPool(env, pick, lead, partnerDealers, tags[i])));

  // Phase B (sync, no I/O): claim distinct listings across positions so the
  // same live listing isn't recommended 3 times in one report. Pools are
  // already distance-ranked (partner dealers first, then closest), so this
  // just walks each position's ranked pool for the best VIN nobody else has
  // taken yet.
  const claimedVins = new Set();
  const winners = pools.map(({ searchResult }) => {
    const candidate = (searchResult.listings || []).find(l => {
      const vin = listingVin(l);
      return !vin || !claimedVins.has(vin);
    });
    const vin = candidate && listingVin(candidate);
    if (vin) claimedVins.add(vin);
    return candidate || null;
  });

  // Phase B.5 (sequential I/O, ~250ms staggered): fetch photos for these 3
  // finalists only — never the full candidate pools — per Auto.dev's 5 req/s
  // free-tier limit. Positions with no winner get {photos:[], photosMissing:true}
  // immediately, no API call.
  const tPhotos = Date.now();
  const photosByPosition = await fetchFinalistPhotos(env, winners, leadId);
  console.log(`[timing] finalist photos: ${Date.now() - tPhotos}ms`);

  // Phase C (parallel I/O): verify the winning listing is still live, build
  // each position's final entry (year/make/model/trim bound to the matched
  // listing, not the pick), then run spec enrichment against that same
  // corrected vehicle so trim-level specs (safety rating, cargo space, etc.)
  // describe the actual matched car rather than Claude's original guess.
  const vehicles = await Promise.all(picks.map(async (pick, i) => {
    const entry = await buildVehicleEntry(env, pick, winners[i], pools[i], photosByPosition[i], lead, partnerDealers, tags[i]);
    const tSpecs = Date.now();
    const specs = await enrichVehicleSpecs(env, entry, {});
    console.log(`[timing] ${tags[i]} enrichSpecs: ${Date.now() - tSpecs}ms`);
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
  }));
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
        safety_rating, cargo_space, seating_capacity, warranty, notable_features, photo_url, photo_urls, photos_missing, search_log
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId, i + 1, v.year, v.make, v.model, v.trim, v.rationale,
      v.price, v.mileage, v.dealer_name, v.dealer_city, v.dealer_state, v.vdp_url, v.source, v.verified,
      v.engine, v.transmission, v.drivetrain, v.city_mpg, v.highway_mpg, v.exterior_color, v.exterior_color_options,
      v.safety_rating, v.cargo_space, v.seating_capacity, v.warranty, v.notable_features, v.photo_url, v.photo_urls, v.photos_missing ?? 0, v.search_log
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
            ${v.photos_missing && v.source !== 'sourcing_in_progress' ? `<br/><strong style="color:#9B2335">⚠ No photos found — please source manually</strong>` : ''}
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

function mileageTolerance(mileage) {
  if (mileage == null) return null;
  if (mileage < 10000) return 3000;
  if (mileage < 20000) return 5000;
  if (mileage < 50000) return 10000;
  if (mileage < 100000) return 15000;
  return 20000;
}

async function searchMarketcheckComps(env, { make, model, trim, zip, year, mileage, throttledFetch }) {
  if (!make) return { comps: [], log: [{ note: 'No make/model available to search comps.' }] };

  const yearMin = year ? Number(year) - 1 : null;
  const yearMax = year ? Number(year) + 1 : null;
  const mileageTol = mileageTolerance(mileage);
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
      if (mileageTol != null && (l.miles == null || Math.abs(l.miles - mileage) > mileageTol)) return false;
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

// ── Valuation discount pipeline ──────────────────────────────────
// Numbers are computed here in code, not left to an LLM to "blend" — a
// clean-title comp baseline run through hard, sequential percentage
// discounts. Claude's only remaining job (generateValuationNarrative,
// below) is to explain the already-computed numbers, never to invent them.
//
// STARTING ESTIMATES, not a final formula — calibrate these against real
// instant-offer comparisons (Carvana/CarMax) over the next several cases.
// Source: salvage-title valuation research (SCA Auction, RevRoom, Edmunds)
// puts unrepaired salvage at 40-60% off clean comp, rebuilt/retitled at
// 20-40% off, flood typically the steepest. These starting points sit
// within (usually the lower-middle of) those ranges — recalibrate as real
// cases come in, and prefer nudging them AFTER seeing a few more
// comparisons over trusting them as precise today.
const TITLE_STATUS_DISCOUNTS = {
  clean: 0,
  salvage: 0.42,
  rebuilt: 0.25,
  flood: 0.48,
  lemon_law_buyback: 0.30,
  not_sure: 0.42, // treated at salvage-tier until admin confirms actual status
};

// Title statuses where the computed number should always be eyeballed,
// regardless of severity — not just flagged for LOW_CONFIDENCE.
const TITLE_STATUS_ALWAYS_REVIEW = new Set(['flood', 'lemon_law_buyback']);

const ACCIDENT_SEVERITY_DISCOUNTS = {
  none: 0,
  minor: 0.05,
  moderate: 0.14,
  major: 0.28,
};

const CONDITION_DISCOUNTS = {
  excellent: 0,
  good: 0.04,
  fair: 0.12,
  poor: 0.22,
};

const MECHANICAL_DISCOUNTS = {
  'running well': 0,
  'needs work': 0.08,
  'not running': 0.20,
};

// Dealer-facing margin steps, applied on top of the title/accident/condition/
// mechanical-adjusted number (NOT on the raw clean-title baseline) — this is
// what makes cash/trade-in "reflect the discount most aggressively," since
// they compound the full chain before this margin is even taken.
const DEALER_TRADE_IN_MARGIN = 0.12;   // retail-adjusted → trade-in
const DEALER_CASH_EXTRA_DISCOUNT = 0.04; // trade-in → cash/quick-sell

// Private-sale buyers for damaged/salvage cars are a different, smaller
// pool (rebuilders, exporters, budget buyers) rather than "normal"
// private-party demand discounted the same way — so title/accident
// discounts apply at reduced strength here, while condition/mechanical
// (which matter to any buyer) still apply in full.
const PRIVATE_SALE_TITLE_ACCIDENT_DAMPENING = 0.55; // fraction of the dealer-facing rate that still applies
const PRIVATE_SALE_FRICTION_DISCOUNT = 0.05; // typical self-listing haggle-down

// Blank input is handled by the caller (defaults to 'clean' only when
// title_status was never provided at all — see generateValuationForLead).
// Everything this function actually sees should map to a real status;
// anything unrecognized falls to 'not_sure', NEVER 'clean' — an unclear
// title status must stay a distinct, flagged state, not silently become
// the best-case assumption.
function normalizeTitleStatus(raw) {
  const key = (raw || '').toString().trim().toLowerCase().replace(/[\s/-]+/g, '_');
  if (TITLE_STATUS_DISCOUNTS[key] != null) return key;
  if (key.includes('salvage')) return 'salvage';
  if (key.includes('rebuilt') || key.includes('reconstructed')) return 'rebuilt';
  if (key.includes('flood')) return 'flood';
  if (key.includes('lemon')) return 'lemon_law_buyback';
  if (key.includes('clean')) return 'clean';
  return 'not_sure';
}

// Baseline retail comp value derived directly from the comps Marketcheck
// already returned (median price of matched listings) — no LLM guess
// involved. Falls back to null if there's nothing to compute from; caller
// is responsible for the no-comps fallback estimate.
function computeCompBaseline(comps) {
  const prices = (comps || []).map(c => c.price).filter(p => typeof p === 'number' && p > 0);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);
}

// Only used when there are no usable comps at all — a narrow fallback
// estimate of the clean-title baseline itself, never the discounted
// numbers. Keeps the pipeline working when Marketcheck has nothing for
// this spec/region, without letting an LLM anywhere near the discount math.
async function estimateBaselineFromKnowledge(env, vehicle, mileage) {
  const tool = {
    name: 'record_baseline',
    description: 'Record an estimated clean-title retail market value for this exact vehicle spec and mileage, with no comps available.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        baseline_value: { type: 'integer', description: 'Estimated clean-title retail market value in USD, for this exact year/make/model/trim at this mileage — no comps were available to ground this, so use general market knowledge.' },
      },
      required: ['baseline_value'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 256,
      tools: [tool], tool_choice: { type: 'tool', name: 'record_baseline' },
      messages: [{ role: 'user', content: `No comparable active listings were found for this vehicle. Estimate a clean-title retail market value.\n\nVehicle: ${vehicle.year || '?'} ${vehicle.make || '?'} ${vehicle.model || '?'} ${vehicle.trim || ''}\nMileage: ${mileage != null ? Number(mileage).toLocaleString() + ' mi' : 'not provided'}` }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.stop_reason === 'refusal') return null;
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  return toolUse?.input?.baseline_value ?? null;
}

// The hard-discount pipeline itself — pure function, no I/O, fully
// deterministic given the same inputs. This is what replaced the old
// "ask Claude to blend everything" approach.
function computeValuationNumbers({ baseline, titleStatusKey, accidentSeverity, condition, mechanicalStatus }) {
  const titleDiscount = TITLE_STATUS_DISCOUNTS[titleStatusKey] ?? TITLE_STATUS_DISCOUNTS.not_sure;
  const accidentDiscount = ACCIDENT_SEVERITY_DISCOUNTS[(accidentSeverity || 'none').toLowerCase()] ?? 0;
  const conditionDiscount = CONDITION_DISCOUNTS[(condition || '').toLowerCase()] ?? 0;
  const mechanicalDiscount = MECHANICAL_DISCOUNTS[(mechanicalStatus || '').toLowerCase()] ?? 0;

  // Dealer-facing chain: title -> accident -> condition -> mechanical,
  // each compounding on the already-discounted number, per Fix C.
  const dealerAdjusted = baseline * (1 - titleDiscount) * (1 - accidentDiscount) * (1 - conditionDiscount) * (1 - mechanicalDiscount);
  const retailValue = Math.round(dealerAdjusted);
  const tradeInValue = Math.round(dealerAdjusted * (1 - DEALER_TRADE_IN_MARGIN));
  const cashValue = Math.round(tradeInValue * (1 - DEALER_CASH_EXTRA_DISCOUNT));

  // Private-sale chain: title/accident discounts dampened (different,
  // smaller buyer pool for damaged/salvage cars), condition/mechanical
  // apply in full since those matter to any buyer.
  const dampenedTitleDiscount = titleDiscount * PRIVATE_SALE_TITLE_ACCIDENT_DAMPENING;
  const dampenedAccidentDiscount = accidentDiscount * PRIVATE_SALE_TITLE_ACCIDENT_DAMPENING;
  const privateAdjusted = baseline * (1 - dampenedTitleDiscount) * (1 - dampenedAccidentDiscount) * (1 - conditionDiscount) * (1 - mechanicalDiscount);
  const privateSaleValue = Math.round(privateAdjusted * (1 - PRIVATE_SALE_FRICTION_DISCOUNT));

  const lowConfidence = titleStatusKey !== 'clean' || (accidentSeverity || '').toLowerCase() === 'major';
  const alwaysReview = TITLE_STATUS_ALWAYS_REVIEW.has(titleStatusKey);

  return {
    retailValue, cashValue, tradeInValue, privateSaleValue,
    lowConfidence: lowConfidence || alwaysReview,
    breakdown: {
      baseline, titleStatusKey, titleDiscount, accidentSeverity: accidentSeverity || 'none', accidentDiscount,
      condition: condition || null, conditionDiscount, mechanicalStatus: mechanicalStatus || null, mechanicalDiscount,
      dealerTradeInMargin: DEALER_TRADE_IN_MARGIN, dealerCashExtraDiscount: DEALER_CASH_EXTRA_DISCOUNT,
      privateSaleTitleAccidentDampening: PRIVATE_SALE_TITLE_ACCIDENT_DAMPENING, privateSaleFrictionDiscount: PRIVATE_SALE_FRICTION_DISCOUNT,
    },
  };
}

// Claude's only remaining job: explain numbers that are already final,
// never determine them. The prompt is deliberately explicit that the
// figures are fixed so a capable model doesn't "helpfully" adjust them.
function buildValuationNarrativePrompt({ vehicle, mileage, comps, selfReported, photoAssessment, values }) {
  const compsText = comps.length
    ? comps.map(c => `- ${c.build?.year || '?'} ${c.build?.make || ''} ${c.build?.model || ''} ${c.build?.trim || ''}, ${c.miles != null ? Number(c.miles).toLocaleString() + ' mi' : 'mileage unknown'}, listed at $${c.price != null ? Number(c.price).toLocaleString() : '?'} — ${c.dealer?.city || ''}${c.dealer?.state ? ', ' + c.dealer.state : ''}`).join('\n')
    : 'No comparable active retail listings were found for this spec/mileage/region — the baseline was estimated from general market knowledge instead.';

  const photoSection = photoAssessment ? `

Photo-confirmed condition assessment:
- Exterior: ${photoAssessment.exterior_score}/10 — ${photoAssessment.exterior_notes}
- Interior: ${photoAssessment.interior_score}/10 — ${photoAssessment.interior_notes}
- Tires: ${photoAssessment.tires_score}/10 — ${photoAssessment.tires_notes}
- Engine bay: ${photoAssessment.engine_bay_score}/10 — ${photoAssessment.engine_bay_notes}
${photoAssessment.mismatches?.length ? `- Mismatches vs. self-report: ${photoAssessment.mismatches.join('; ')}` : '- No mismatches vs. self-report noted.'}
` : '';

  return `A client is selling their vehicle through our "Sell My Car" service. The four values below are ALREADY FINAL — they were computed by our own pricing logic, not by you. Your only job is to write a short (2-3 sentence), plain-English reasoning for each one, grounded in the details below. Do not suggest different numbers or imply these figures might be wrong.

Vehicle: ${vehicle.year || '?'} ${vehicle.make || '?'} ${vehicle.model || '?'} ${vehicle.trim || ''}
Mileage: ${mileage != null ? Number(mileage).toLocaleString() + ' mi' : 'not provided'}

Self-reported condition:
- Title status: ${selfReported.title_status || 'not specified'}
- General condition: ${selfReported.general_condition || 'not specified'}
- Accident history: ${selfReported.accident_history}${selfReported.accident_notes ? ` — ${selfReported.accident_notes}` : ''}
- Mechanical status: ${selfReported.mechanical_status || 'not specified'}${selfReported.mechanical_notes ? ` — ${selfReported.mechanical_notes}` : ''}
${photoSection}
Comparable active retail listings:
${compsText}

Final values to explain:
- Cash/Quick Sell (dealer buys outright, no obligation): $${values.cashValue.toLocaleString()}
- Trade-In (applied toward another vehicle purchase): $${values.tradeInValue.toLocaleString()}
- Private Sale estimate (self-listing, e.g. Facebook Marketplace): $${values.privateSaleValue.toLocaleString()}
- Retail Comp Value (internal reference only, not shown to the client): $${values.retailValue.toLocaleString()}

Write reasoning for each of the four values above.`;
}

async function generateValuationNarrative(env, args) {
  const tool = {
    name: 'record_valuation_narrative',
    description: 'Record a short reasoning explanation for each already-computed valuation figure.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        cash_reasoning: { type: 'string' },
        trade_in_reasoning: { type: 'string' },
        private_sale_reasoning: { type: 'string' },
        retail_reasoning: { type: 'string' },
      },
      required: ['cash_reasoning', 'trade_in_reasoning', 'private_sale_reasoning', 'retail_reasoning'],
      additionalProperties: false,
    },
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_valuation_narrative' },
      messages: [{ role: 'user', content: buildValuationNarrativePrompt(args) }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error (valuation narrative): HTTP ${res.status}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the valuation narrative request');
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
    make: normalizeMakeForMarketcheck(vehicle.make), model: normalizeModelForMarketcheck(vehicle.model), trim: vehicle.trim,
    zip: input.zip, year: vehicle.year, mileage: input.mileage, throttledFetch,
  });
  console.log(`[timing] valuation lead ${leadId} comps: ${Date.now() - tComps}ms, count=${comps.length}`);

  // 'not_sure' only if truly selected — a genuinely blank field defaults to
  // clean, per Fix A, but must not be confused with an explicit "not sure."
  const titleStatusKey = input.title_status ? normalizeTitleStatus(input.title_status) : 'clean';

  const selfReported = {
    title_status: input.title_status || 'Clean',
    general_condition: input.general_condition || null,
    accident_history: input.accident_history || 'none',
    accident_notes: input.accident_notes || null,
    mechanical_status: input.mechanical_status || null,
    mechanical_notes: input.mechanical_notes || null,
  };

  const tSynth = Date.now();
  let baseline = computeCompBaseline(comps);
  if (baseline == null) baseline = await estimateBaselineFromKnowledge(env, vehicle, input.mileage);
  if (baseline == null) throw new Error(`No comp baseline and no fallback estimate available for lead ${leadId}`);

  const values = computeValuationNumbers({
    baseline, titleStatusKey,
    accidentSeverity: selfReported.accident_history,
    condition: selfReported.general_condition,
    mechanicalStatus: selfReported.mechanical_status,
  });

  const narrative = await generateValuationNarrative(env, { vehicle, mileage: input.mileage, comps, selfReported, values });
  console.log(`[timing] valuation lead ${leadId} synthesis: ${Date.now() - tSynth}ms`);

  const token = randomHex(20);
  await env.DB.prepare(`
    INSERT INTO vehicle_valuations (
      lead_id, token, vin, decoded_year, decoded_make, decoded_model, decoded_trim, decoded_engine, decoded_drivetrain, decoded_body_type, decode_raw,
      mileage, title_status, accident_history, accident_notes, general_condition, mechanical_status, mechanical_notes,
      marketcheck_comps, marketcheck_log,
      final_retail_value, final_cash_value, final_trade_in_value, final_private_sale_value,
      valuation_reasoning, valuation_breakdown, low_confidence,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_photos')
  `).bind(
    leadId, token, input.vin || null,
    decoded?.year ?? null, decoded?.make || null, decoded?.model || null, decoded?.trim || null,
    decoded?.engine || null, decoded?.drivetrain || null, decoded?.body_type || null, decoded ? JSON.stringify(decoded) : null,
    input.mileage ?? null, selfReported.title_status, selfReported.accident_history, selfReported.accident_notes,
    selfReported.general_condition, selfReported.mechanical_status, selfReported.mechanical_notes,
    JSON.stringify(comps), JSON.stringify(log),
    values.retailValue, values.cashValue, values.tradeInValue, values.privateSaleValue,
    JSON.stringify({ retail: narrative.retail_reasoning, cash: narrative.cash_reasoning, trade_in: narrative.trade_in_reasoning, private_sale: narrative.private_sale_reasoning }),
    JSON.stringify(values.breakdown), values.lowConfidence ? 1 : 0
  ).run();

  await sendSellCarReceivedEmail(env, { first_name: lead.first_name, email: lead.email, token });

  await notifyCrm(env, '/api/hooks/log-touch', {
    funnel_type: 'sell_my_car', source_lead_id: leadId, type: 'confirmation_email',
  }).catch(err => console.error('CRM log-touch hook failed', leadId, err));

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

  if (!res.ok) throw new Error(`Claude API error (condition assessment): HTTP ${res.status}`);
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
    <p>Thanks for sending over the photos. Based on everything you've shared, here's your vehicle's value range:</p>
    <p style="font-family:Georgia,serif;font-size:1.4rem;color:#0C1C33;text-align:center;margin:1.5rem 0"><strong>$${Number(low).toLocaleString()} – $${Number(high).toLocaleString()}</strong></p>
    <p style="font-size:.8rem;color:#4A5568">Based on the information and photos you provided, subject to revision.</p>
    <p>We're now reaching out to our network of dealer and buyer partners to line up real offers on your vehicle. We'll be in touch as soon as we hear back.</p>
    <p><a href="${reportUrl}">View your full valuation report →</a></p>
    <p>— Jeff</p>
  `);
  return sendBrevoEmail(env, {
    to: email,
    subject: "Your vehicle's value — we're lining up offers now",
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
    title_status: valuation.title_status || 'Clean',
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
  // Re-derive from the same stored comps rather than trusting the original
  // final_* numbers — keeps this path on the same code-computed pipeline
  // as the initial valuation instead of asking Claude to re-blend.
  // NOTE: photo-confirmed condition scores aren't folded into the discount
  // math yet (this path is currently dormant — see processPhotoConfirmedValuation
  // caller — while Anthropic's URL-based image fetch is down account-wide).
  // Worth revisiting once it's back in use: a photo-confirmed condition
  // meaningfully worse than self-reported should probably steepen the
  // condition discount, not just get a note in the narrative.
  let baseline = computeCompBaseline(comps);
  if (baseline == null) baseline = await estimateBaselineFromKnowledge(env, vehicle, valuation.mileage);
  if (baseline == null) throw new Error(`No comp baseline and no fallback estimate available for valuation ${valuation.id}`);

  const titleStatusKey = normalizeTitleStatus(selfReported.title_status);
  const values = computeValuationNumbers({
    baseline, titleStatusKey,
    accidentSeverity: selfReported.accident_history,
    condition: selfReported.general_condition,
    mechanicalStatus: selfReported.mechanical_status,
  });

  const narrative = await generateValuationNarrative(env, { vehicle, mileage: valuation.mileage, comps, selfReported, photoAssessment: assessment, values });
  console.log(`[timing] photo valuation ${token} synthesis: ${Date.now() - tSynth}ms`);

  await env.DB.prepare(`
    UPDATE vehicle_valuations SET
      ai_condition_score = ?, photo_confirmed = 1,
      final_retail_value = ?, final_cash_value = ?, final_trade_in_value = ?, final_private_sale_value = ?,
      valuation_reasoning = ?, valuation_breakdown = ?, low_confidence = ?,
      status = 'valued', customer_notified_at = datetime('now')
    WHERE id = ?
  `).bind(
    JSON.stringify(assessment),
    values.retailValue, values.cashValue, values.tradeInValue, values.privateSaleValue,
    JSON.stringify({ retail: narrative.retail_reasoning, cash: narrative.cash_reasoning, trade_in: narrative.trade_in_reasoning, private_sale: narrative.private_sale_reasoning }),
    JSON.stringify(values.breakdown), values.lowConfidence ? 1 : 0,
    valuation.id
  ).run();

  await sendSellCarValueRangeEmail(env, {
    first_name: valuation.first_name, email: valuation.email, token,
    low: Math.min(values.cashValue, values.tradeInValue, values.privateSaleValue),
    high: Math.max(values.cashValue, values.tradeInValue, values.privateSaleValue),
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

function parseEditedPrice(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Math.round(Number(val));
  return Number.isNaN(n) ? fallback : n;
}

// Shared by "Save Changes" (adminSaveValuationEdits) and "Send Value to
// Customer" (adminSendValuationEmail) — editing values persists and
// regenerates the narrative either way; only whether the customer gets
// (re-)notified differs. Editing a record that's already been sent just
// updates it in place — re-notification is a deliberate separate action,
// not something this triggers automatically (Fix E, point 4).
async function saveValuationEdits(env, params, body, dealer) {
  const valuation = await env.DB.prepare(`
    SELECT vehicle_valuations.*,
      sell_my_car_leads.first_name, sell_my_car_leads.email,
      sell_my_car_leads.year AS lead_year, sell_my_car_leads.make AS lead_make,
      sell_my_car_leads.model AS lead_model, sell_my_car_leads.trim AS lead_trim
    FROM vehicle_valuations
    JOIN sell_my_car_leads ON sell_my_car_leads.id = vehicle_valuations.lead_id
    WHERE vehicle_valuations.lead_id = ?
  `).bind(+params.id).first();
  if (!valuation) return { error: json({ error: 'No valuation found for this lead yet.' }, 404) };

  const cash     = parseEditedPrice(body.cash_value, valuation.final_cash_value);
  const tradeIn  = parseEditedPrice(body.trade_in_value, valuation.final_trade_in_value);
  const private_ = parseEditedPrice(body.private_sale_value, valuation.final_private_sale_value);
  const retail   = parseEditedPrice(body.retail_value, valuation.final_retail_value);
  if (cash == null || tradeIn == null || private_ == null || retail == null) {
    return { error: json({ error: 'Please enter values for all four prices.' }, 400) };
  }

  const valuesChanged = cash !== valuation.final_cash_value || tradeIn !== valuation.final_trade_in_value
    || private_ !== valuation.final_private_sale_value || retail !== valuation.final_retail_value;

  let existingReasoning = {};
  try { existingReasoning = JSON.parse(valuation.valuation_reasoning || '{}'); } catch { existingReasoning = {}; }

  // body.reasoning is the manual-wording fallback (Fix E, point 2) — if the
  // admin hand-edited the narrative text, use that verbatim and skip the
  // Claude call entirely. Otherwise, if the numbers changed, regenerate so
  // the written explanation stays consistent with what's actually shown.
  let reasoning = existingReasoning;
  if (body.reasoning && typeof body.reasoning === 'object') {
    reasoning = { ...existingReasoning, ...body.reasoning };
  } else if (valuesChanged) {
    const vehicle = {
      year: valuation.decoded_year || valuation.lead_year || null,
      make: valuation.decoded_make || valuation.lead_make || null,
      model: valuation.decoded_model || valuation.lead_model || null,
      trim: valuation.decoded_trim || valuation.lead_trim || null,
    };
    let comps = []; try { comps = JSON.parse(valuation.marketcheck_comps || '[]'); } catch { comps = []; }
    let photoAssessment = null; try { photoAssessment = valuation.ai_condition_score ? JSON.parse(valuation.ai_condition_score) : null; } catch { photoAssessment = null; }
    const selfReported = {
      title_status: valuation.title_status || 'Clean',
      general_condition: valuation.general_condition,
      accident_history: valuation.accident_history,
      accident_notes: valuation.accident_notes,
      mechanical_status: valuation.mechanical_status,
      mechanical_notes: valuation.mechanical_notes,
    };
    const narrative = await generateValuationNarrative(env, {
      vehicle, mileage: valuation.mileage, comps, selfReported, photoAssessment,
      values: { cashValue: cash, tradeInValue: tradeIn, privateSaleValue: private_, retailValue: retail },
    });
    reasoning = { retail: narrative.retail_reasoning, cash: narrative.cash_reasoning, trade_in: narrative.trade_in_reasoning, private_sale: narrative.private_sale_reasoning };
  }

  const manuallyAdjusted = valuesChanged || (body.reasoning && typeof body.reasoning === 'object');

  await env.DB.prepare(`
    UPDATE vehicle_valuations SET
      final_retail_value = ?, final_cash_value = ?, final_trade_in_value = ?, final_private_sale_value = ?,
      valuation_reasoning = ?
      ${manuallyAdjusted ? ', manually_adjusted = 1, manually_adjusted_at = datetime(\'now\'), manually_adjusted_by = ?' : ''}
    WHERE id = ?
  `).bind(
    ...(manuallyAdjusted
      ? [retail, cash, tradeIn, private_, JSON.stringify(reasoning), dealer?.name || dealer?.email || 'admin', valuation.id]
      : [retail, cash, tradeIn, private_, JSON.stringify(reasoning), valuation.id])
  ).run();

  return { valuation, cash, tradeIn, private_, retail, reasoning };
}

async function adminSaveValuationEdits(request, env, params, dealer) {
  const body = await request.json().catch(() => ({}));
  const result = await saveValuationEdits(env, params, body, dealer);
  if (result.error) return result.error;
  return json({ success: true, cash_value: result.cash, trade_in_value: result.tradeIn, private_sale_value: result.private_, retail_value: result.retail, reasoning: result.reasoning });
}

async function adminSendValuationEmail(request, env, params, dealer) {
  const body = await request.json().catch(() => ({}));
  const result = await saveValuationEdits(env, params, body, dealer);
  if (result.error) return result.error;
  const { valuation, cash, tradeIn, private_ } = result;

  await env.DB.prepare(`
    UPDATE vehicle_valuations SET status = 'valued', customer_notified_at = datetime('now') WHERE id = ?
  `).bind(valuation.id).run();

  await sendSellCarValueRangeEmail(env, {
    first_name: valuation.first_name, email: valuation.email, token: valuation.token,
    low: Math.min(cash, tradeIn, private_),
    high: Math.max(cash, tradeIn, private_),
  });

  return json({ success: true });
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
    valuation.title_status && ['Title Status', valuation.title_status],
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
      ${valueCard('Cash / Quick Sell', valuation.final_cash_value, reasoning.cash)}
      ${valueCard('Trade-In Value', valuation.final_trade_in_value, reasoning.trade_in)}
      ${valueCard('Private Sale (Est.)', valuation.final_private_sale_value, reasoning.private_sale)}
    </div>
    <p class="footnote" style="margin-top:1rem">Cash/Quick Sell and Trade-In reflect real dealer-partner offers. Private Sale is an estimate for listing it yourself (e.g. Facebook Marketplace) — not a guarantee, and it takes your own time and effort to realize. All figures are based on self-reported and photo-confirmed information, subject to revision.</p>
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
      vehicle_valuations.final_retail_value, vehicle_valuations.final_cash_value, vehicle_valuations.final_trade_in_value, vehicle_valuations.final_private_sale_value,
      vehicle_valuations.low_confidence,
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
        ${valuation.low_confidence ? `<p style="color:#9B2335"><strong>⚠ Low confidence — eyeball this one before proceeding.</strong></p>` : ''}
        <p><strong>Values:</strong> Retail ${valuation.final_retail_value ? '$' + Number(valuation.final_retail_value).toLocaleString() : '—'} ·
          Cash ${valuation.final_cash_value ? '$' + Number(valuation.final_cash_value).toLocaleString() : '—'} ·
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

  // Required — a value this significant to the valuation can't be left to
  // whatever gets parsed out of the free-text accident description. A
  // truly blank submission defaults to Clean; "Not Sure" is a distinct,
  // deliberately-selected value and must NOT be coerced to Clean.
  const title_status = (body.title_status || '').trim() || 'Clean';

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
    title_status, body.remaining_balance || '', (body.payoff_amount || '').trim(), body.condition || '',
    body.accidents || '', (body.accidents_count || '').trim(), (body.accidents_damage || '').trim(),
    body.mechanical_issues || '', (body.mechanical_desc || '').trim(), body.warning_lights || '',
    body.windshield || '', body.tires || '', body.modifications || '', (body.modifications_desc || '').trim(),
    body.keys || '', body.timeline || '', (body.notes || '').trim()
  ).run();

  const leadId = result.meta.last_row_id;

  if (ctx) {
    // Same hard 30s ctx.waitUntil() ceiling risk as the Find My Car pipeline —
    // hand off to the queue instead of running the VIN decode + comps + Claude
    // valuation chain inline.
    const input = {
      vin, mileage, year, make, model, trim, zip,
      title_status,
      general_condition: body.condition || '',
      accident_history, accident_notes, mechanical_status, mechanical_notes,
    };
    ctx.waitUntil(env.JOB_QUEUE.send({ type: 'sell_car_valuation', leadId, input }).catch(err => console.error('failed to enqueue valuation job for lead', leadId, err)));

    const currentVehicle = [year, make, model, trim].filter(Boolean).join(' ') || null;
    ctx.waitUntil(notifyCrm(env, '/api/hooks/lead-created', {
      funnel_type: 'sell_my_car', source_lead_id: leadId,
      first_name, last_name, email, phone,
      current_vehicle: currentVehicle, vehicle_description: currentVehicle,
      trade_in: 0,
    }).catch(err => console.error('CRM lead-created hook failed', leadId, err)));
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
  const { results } = await env.DB.prepare(`
    SELECT dealers.id, dealers.name, dealers.dealership_name, dealers.email, dealers.role, dealers.status, dealers.created_at,
      EXISTS(SELECT 1 FROM admin_seen_items WHERE section = 'dealers' AND item_id = dealers.id) as seen
    FROM dealers WHERE role != 'admin' ORDER BY created_at DESC
  `).all();
  return json({ dealers: results.map(d => ({ ...d, seen: !!d.seen })) });
}

// ── Notification badges ──────────────────────────────────────────
// iOS-style unread counts per dashboard section — but "read" is per ITEM,
// marked only when admin actually reviews/approves/expands that specific
// item, never just from opening the tab (opening a tab must not be able to
// hide a submission that was never actually looked at).
const NOTIFICATION_SECTION_TABLES = {
  newsletter: 'inventory_submissions',
  find_car:   'find_car_reports',
  sell_car:   'sell_my_car_leads',
  messages:   'contact_messages',
  dealers:    'dealers',
};
const NOTIFICATION_SECTIONS = Object.keys(NOTIFICATION_SECTION_TABLES);

async function adminNotificationCounts(request, env) {
  const counts = {};
  for (const section of NOTIFICATION_SECTIONS) {
    const table = NOTIFICATION_SECTION_TABLES[section];
    const dealerFilter = section === 'dealers' ? `role != 'admin' AND ` : '';
    const row = await env.DB.prepare(`
      SELECT COUNT(*) as c FROM ${table} t
      WHERE ${dealerFilter}NOT EXISTS (SELECT 1 FROM admin_seen_items WHERE section = ? AND item_id = t.id)
    `).bind(section).first();
    counts[section] = row.c;
  }
  return json({ counts });
}

async function adminMarkItemSeen(request, env, params) {
  if (!NOTIFICATION_SECTIONS.includes(params.section)) return json({ error: 'Unknown section.' }, 400);
  const itemId = +params.itemId;
  if (!itemId) return json({ error: 'Invalid item id.' }, 400);
  await env.DB.prepare(`
    INSERT INTO admin_seen_items (section, item_id) VALUES (?, ?)
    ON CONFLICT(section, item_id) DO NOTHING
  `).bind(params.section, itemId).run();
  return json({ success: true });
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

async function dealerSignup(request, env, params, dealer, token2, ctx) {
  const body = await request.json().catch(() => ({}));
  const token           = (body.token || '').trim();
  const first_name      = (body.first_name || '').trim();
  const last_name       = (body.last_name || '').trim();
  const dealership_name = (body.dealership_name || '').trim();
  const email           = (body.email || '').trim().toLowerCase();
  const password        = body.password || '';

  if (!token) return json({ error: 'Missing invite token.' }, 400);
  if (!first_name || !last_name || !dealership_name || !email || !password || !body.dealership_website) {
    return json({ error: 'All fields are required.' }, 400);
  }
  if (!EMAIL_RE.test(email)) return json({ error: 'Invalid email address.' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);

  const { url: dealership_website, error: websiteError } = normalizeWebsiteUrl(body.dealership_website);
  if (websiteError) return json({ error: websiteError }, 400);

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
    `INSERT INTO dealers (name, dealership_name, dealership_website, email, password_hash, password_salt, role, status)
     VALUES (?, ?, ?, ?, ?, ?, 'dealer', 'active')`
  ).bind(name, dealership_name, dealership_website, email, hash, salt).run();

  const dealerId = result.meta.last_row_id;

  await env.DB.prepare(
    `UPDATE dealer_invites SET status = 'used', used_at = datetime('now'), dealer_id = ? WHERE id = ?`
  ).bind(dealerId, invite.id).run();

  const sessionToken = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO dealer_sessions (id, dealer_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`
  ).bind(sessionToken, dealerId).run();

  // Gated behind DEALER_WELCOME_EMAIL_ENABLED. Sent 30 minutes after signup via the job
  // queue rather than immediately, so a dealer isn't mid-onboarding-form when it lands.
  if (env.DEALER_WELCOME_EMAIL_ENABLED === 'true' && ctx) {
    ctx.waitUntil(env.JOB_QUEUE.send(
      { type: 'dealer_welcome_email', to: email, firstName: first_name },
      { delaySeconds: 1800 }
    ).catch(err => console.error('failed to enqueue welcome email for dealer', dealerId, err)));
  }

  return json({
    token: sessionToken,
    dealer: { id: dealerId, name, dealership_name, dealership_website, email, role: 'dealer' },
  });
}

async function adminUpdateDealer(request, env, params) {
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const values = [];

  if ('status' in body) {
    if (!VALID_DEALER_STATUSES.includes(body.status)) return json({ error: 'Invalid status.' }, 400);
    sets.push('status = ?'); values.push(body.status);
  }
  if ('autodev_dealer_id' in body) {
    sets.push('autodev_dealer_id = ?'); values.push(body.autodev_dealer_id || null);
  }
  if (!sets.length) return json({ error: 'Nothing to update.' }, 400);

  values.push(+params.id);
  await env.DB.prepare(`UPDATE dealers SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ success: true });
}

// Auto.dev has no exact dealerId filter, only a name filter — and dealer
// names aren't unique (confirmed live: two unrelated dealers both named
// "Audi North Austin"). This searches by the partner's registered
// dealership_name and groups results by the dealerId Auto.dev actually
// returns, so an admin can visually confirm the right one (by city/state/
// sample listings) before saving it via PATCH /api/admin/dealers/:id.
async function adminAutodevDealerLookup(request, env, params) {
  const url = new URL(request.url);
  const dealer = await env.DB.prepare('SELECT id, dealership_name FROM dealers WHERE id = ?').bind(+params.id).first();
  if (!dealer) return json({ error: 'Dealer not found.' }, 404);

  const zip = url.searchParams.get('zip') || '';
  const distance = url.searchParams.get('distance') || '50';
  // No ?select= — retailListing.dealerId silently returns null under
  // select regardless of field path (confirmed live), and that's the one
  // field this lookup exists to get right.
  const { ok, status, data } = await autodevFetch(env, '/listings', {
    'retailListing.dealer': dealer.dealership_name,
    zip: zip || undefined,
    distance: zip ? distance : undefined,
    limit: 50,
  }, {});

  if (!ok) return json({ error: `Auto.dev search failed (HTTP ${status}).` }, 502);

  const byId = new Map();
  for (const raw of data?.data || []) {
    const v = raw.vehicle || {};
    const r = raw.retailListing || {};
    const id = r.dealerId;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, {
        autodev_dealer_id: id,
        dealer_name: r.dealer || null,
        city: r.city || null,
        state: r.state || null,
        zip: r.zip || null,
        sample_makes: new Set(),
        listing_count: 0,
      });
    }
    const entry = byId.get(id);
    entry.listing_count++;
    if (v.make) entry.sample_makes.add(v.make);
  }

  const candidates = [...byId.values()].map(e => ({ ...e, sample_makes: [...e.sample_makes] }));
  return json({ searched_name: dealer.dealership_name, candidates });
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

async function adminApproveReport(request, env, params, dealer, token, ctx) {
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

  if (ctx) {
    ctx.waitUntil(notifyCrm(env, '/api/hooks/log-touch', {
      funnel_type: 'find_my_car', source_lead_id: report.find_lead_id, type: 'report_email', advance_stage: 'report_sent',
    }).catch(err => console.error('CRM log-touch hook failed', report.id, err)));
  }

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

async function publicExpressReportInterest(request, env, params, dealer, token, ctx) {
  const report = await env.DB.prepare(
    `SELECT id, report_code, find_lead_id FROM find_car_reports WHERE report_code = ? AND status = 'approved'`
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

    if (ctx) {
      ctx.waitUntil(notifyCrm(env, '/api/hooks/log-touch', {
        funnel_type: 'find_my_car', source_lead_id: report.find_lead_id, type: 'interested',
        summary: `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`,
        advance_stage: 'negotiation',
      }).catch(err => console.error('CRM log-touch hook failed', vehicle.id, err)));
    }
  }

  return json({ success: true, deep_dive_url: deepDiveUrl });
}

// White Glove fee tiers. Above $200k there's no defined tier yet, so the
// customer sees "I'll follow up with pricing" instead of a number, and we
// flag it for Jeff to price manually rather than guessing.
function computeWhiteGloveFee(price) {
  if (price == null) return null;
  if (price < 50000) return 250;
  if (price < 100000) return 350;
  if (price < 200000) return 500;
  return null;
}

async function publicRequestWhiteGlove(request, env, params, dealer, token, ctx) {
  const report = await env.DB.prepare(
    `SELECT id, report_code, find_lead_id FROM find_car_reports WHERE report_code = ? AND status = 'approved'`
  ).bind(params.code).first();
  if (!report) return json({ error: 'Report not found.' }, 404);

  const position = +params.position;
  const vehicle = await env.DB.prepare(
    'SELECT id, year, make, model, trim, price, white_glove_requested, white_glove_fee FROM report_vehicles WHERE report_id = ? AND position = ?'
  ).bind(report.id, position).first();
  if (!vehicle) return json({ error: 'Vehicle not found.' }, 404);

  const fee = vehicle.white_glove_requested ? vehicle.white_glove_fee : computeWhiteGloveFee(vehicle.price);

  if (!vehicle.white_glove_requested) {
    await env.DB.prepare(
      `UPDATE report_vehicles SET white_glove_requested = 1, white_glove_requested_at = datetime('now'), white_glove_fee = ? WHERE id = ?`
    ).bind(fee, vehicle.id).run();

    const details = await env.DB.prepare(`
      SELECT find_car_leads.first_name, find_car_leads.last_name, find_car_leads.email, find_car_leads.phone
      FROM find_car_reports JOIN find_car_leads ON find_car_leads.id = find_car_reports.find_lead_id
      WHERE find_car_reports.id = ?
    `).bind(report.id).first();

    await sendBrevoEmail(env, {
      to: 'theexactmatch@gmail.com',
      subject: '🎩 White Glove request — needs prompt follow-up',
      html: brandedEmailHtml(`
        <p><strong>${escapeHtml(details.first_name)} ${escapeHtml(details.last_name)}</strong> requested White Glove Service on the
        ${escapeHtml(vehicle.year)} ${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model)} ${escapeHtml(vehicle.trim)}.</p>
        <p><strong>Fee:</strong> ${fee != null ? '$' + fee.toLocaleString() : 'Over $200k — needs manual pricing'}</p>
        <p><strong>Contact:</strong><br/>
        Email: <a href="mailto:${escapeHtml(details.email)}">${escapeHtml(details.email)}</a><br/>
        Phone: ${details.phone ? escapeHtml(details.phone) : 'not provided'}</p>
        <p><a href="https://theexactmatch.com/Dealerportal.html">View in dashboard →</a></p>
      `),
    });

    if (ctx) {
      ctx.waitUntil(notifyCrm(env, '/api/hooks/log-touch', {
        funnel_type: 'find_my_car', source_lead_id: report.find_lead_id, type: 'white_glove_requested',
        summary: `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim} — fee ${fee != null ? '$' + fee : 'TBD (over $200k)'}`,
        advance_stage: 'negotiation',
        set_fields: { white_glove: 1, ...(fee != null ? { fee_amount: fee } : {}) },
      }).catch(err => console.error('CRM log-touch hook failed', vehicle.id, err)));
    }
  }

  return json({ success: true, fee, manual_pricing: fee == null });
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
  const multi = vehicles.length > 1;
  const cards = vehicles.map(v => {
    const detailUrl = `https://theexactmatch.com/reports/${report.report_code}-${slugify(`${v.year} ${v.make} ${v.model} ${v.trim}`)}`;
    return `
    <div class="vcard">
      ${v.photo_url
        ? `<img src="${escapeHtml(v.photo_url)}" alt="${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}" class="vphoto"/>`
        : `<div class="vphoto vphoto-placeholder"><span>Photo coming soon</span></div>`}
      <div class="vbody">
        <div>
          <div class="vtitle">${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}</div>
          <div class="vtrim">${escapeHtml(v.trim || '')}</div>
        </div>
        <div>
          <div class="vprice-label">${v.source === 'sourcing_in_progress' ? 'Status' : 'Listed Price'}</div>
          <div class="vprice">${v.source === 'sourcing_in_progress' ? 'Sourcing in progress' : (v.price != null ? '$' + Number(v.price).toLocaleString() : '—')}</div>
        </div>
        <a class="more-btn" href="${detailUrl}">More Details</a>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Your Matches — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#152238;--navy2:#1e2f4d;--gold:#c9a227;--bronze:#8a6a12;--cream:#f7f4ee;--white:#fff;--ink:#1a1a1a;--border:rgba(21,34,56,.12);--muted:#5b5b5b}
html,body{background:var(--cream)}
body{font-family:'Jost',sans-serif;color:var(--ink);font-weight:300;font-size:.92rem}
h1{font-family:'Playfair Display',serif;font-weight:500;color:var(--white)}
header.hero{background:var(--navy);padding:3.5rem 2rem 3rem;text-align:center}
.eyebrow{font-size:.68rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin-bottom:.9rem}
h1.title{font-size:clamp(1.7rem,3.4vw,2.4rem);line-height:1.25}
h1.title em{font-style:italic;color:var(--gold)}
.sub{color:rgba(247,244,238,.62);font-size:.88rem;margin-top:.85rem;font-weight:300}
.wrap{max-width:1080px;margin:0 auto;padding:3rem 2rem 4rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.6rem}
.vcard{background:var(--white);border:1px solid var(--border);border-radius:5px;overflow:hidden;display:flex;flex-direction:column;transition:box-shadow .2s,transform .2s}
.vcard:hover{box-shadow:0 10px 28px rgba(21,34,56,.12);transform:translateY(-2px)}
.vphoto{width:100%;height:190px;object-fit:cover;display:block;background:var(--cream)}
.vphoto-placeholder{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.75rem;font-style:italic}
.vbody{padding:1.4rem 1.4rem 1.5rem;display:flex;flex-direction:column;gap:.8rem;flex:1}
.vtitle{font-family:'Playfair Display',serif;font-size:1.15rem;font-weight:500;color:var(--ink);line-height:1.3}
.vtrim{font-size:.74rem;color:var(--muted);margin-top:.15rem}
.vprice{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:600;color:var(--navy);margin-top:.2rem}
.vprice-label{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--bronze);margin-bottom:.15rem}
.more-btn{margin-top:auto;padding:.8rem;background:var(--gold);color:var(--navy);border:none;border-radius:3px;font-family:'Jost',sans-serif;font-weight:700;font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;cursor:pointer;text-align:center;text-decoration:none;display:block}
.more-btn:hover{background:#d8b23c}
footer{text-align:center;padding:2.2rem;font-size:.72rem;color:var(--muted)}
</style>
</head>
<body>
<header class="hero">
  <div class="eyebrow">Your Curated Matches</div>
  <h1 class="title">Hi ${escapeHtml(report.first_name)}, here ${multi ? `are <em>your ${vehicles.length} options.</em>` : `is <em>your match.</em>`}</h1>
  <div class="sub">Report ${escapeHtml(report.report_code)}. Questions? Text Jeff at (512) 650-9328.</div>
</header>
<div class="wrap">
  <div class="grid">${cards}</div>
</div>
<footer>© ${new Date().getFullYear()} TheExactMatch.com</footer>
</body></html>`;
}

// Jeff's Target: a realistic below-asking negotiation range, capped so the
// discount never exceeds $5k even on very expensive vehicles. Both bounds
// share the same cap — capping only the 5% end would invert the range once
// 2% alone exceeds $5k (~$250k+ vehicles).
function computeJeffsTarget(price) {
  if (price == null) return null;
  const discountMin = Math.min(price * 0.02, 5000);
  const discountMax = Math.min(price * 0.05, 5000);
  return { low: Math.round(price - discountMax), high: Math.round(price - discountMin) };
}

const OPTION_ACCENT_COLORS = ['#2f5fa8', '#b3492f', '#3f7a52'];

// Estimated-payments assumptions. Not lender-sourced, illustrative only —
// disclosed as such in the rendered note. Flat TX rate/fees regardless of
// the vehicle's dealer state, since the client's registration state isn't
// collected on the form.
const CREDIT_TIERS = [
  { key: 'excellent', label: 'Excellent', apr: 0.06 },
  { key: 'good', label: 'Good', apr: 0.09 },
  { key: 'fair', label: 'Fair', apr: 0.13 },
  { key: 'poor', label: 'Poor', apr: 0.18 },
];
const OTD_TAX_RATE = 0.0625;
const OTD_FLAT_FEES = 300;
const FINANCING_TERMS = [48, 60, 72];

function creditTierFor(creditRange) {
  const key = (creditRange || '').toLowerCase().trim();
  return CREDIT_TIERS.find(t => t.key === key) || CREDIT_TIERS.find(t => t.key === 'good');
}

function computeOtdPrice(price) {
  if (price == null) return null;
  return Math.round((price * (1 + OTD_TAX_RATE) + OTD_FLAT_FEES) * 100) / 100;
}

function monthlyPayment(principal, annualApr, termMonths) {
  if (principal <= 0) return 0;
  const r = annualApr / 12;
  const factor = Math.pow(1 + r, termMonths);
  return principal * r * factor / (factor - 1);
}

// Shown for any payment method (including Cash/Leasing, which don't collect
// credit_range/down_payment on the form) so the section is never conditional
// on a specific answer — missing credit tier falls back to "Good", missing
// down payment falls back to 10% of price, so there's always a sensible
// illustrative table rather than nothing.
function computeFinancingTable(price, downPaymentRaw, creditRange) {
  if (price == null) return null;
  const tier = creditTierFor(creditRange);
  const otd = computeOtdPrice(price);
  const parsedDown = Number(downPaymentRaw);
  const stated = Number.isFinite(parsedDown) && parsedDown > 0 ? parsedDown : Math.round(price * 0.1);
  const downOptions = [Math.max(0, Math.round(stated * 0.8)), stated, Math.round(stated * 1.2)];
  const rows = FINANCING_TERMS.map(term => ({
    term,
    payments: downOptions.map(down => monthlyPayment(otd - down, tier.apr, term)),
  }));
  return { tier, otd, downOptions, rows };
}

function vehicleDeepDiveHtml(report, vehicle, vehicleCount) {
  const v = vehicle;
  const sourcing = v.source === 'sourcing_in_progress';
  let features = [];
  try { features = JSON.parse(v.notable_features || '[]'); } catch { features = []; }
  let photos = [];
  try { photos = JSON.parse(v.photo_urls || '[]'); } catch { photos = []; }
  if (!photos.length && v.photo_url) photos = [v.photo_url];

  const specRows = [
    v.engine && ['Engine', v.engine],
    v.transmission && ['Transmission', v.transmission],
    v.drivetrain && ['Drivetrain', v.drivetrain],
    v.mileage != null && ['Mileage', `${Number(v.mileage).toLocaleString()} mi`],
    v.exterior_color && ['Exterior Color', v.exterior_color],
  ].filter(Boolean);

  const accent = OPTION_ACCENT_COLORS[((v.position || 1) - 1) % OPTION_ACCENT_COLORS.length];
  const target = sourcing ? null : computeJeffsTarget(v.price);
  const fee = sourcing ? null : computeWhiteGloveFee(v.price);
  const financing = sourcing ? null : computeFinancingTable(v.price, report.down_payment, report.credit_range);

  const gallery = photos.length
    ? photos.map(p => `<img src="${escapeHtml(p)}" alt="${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}" class="gphoto"/>`).join('')
    : `<div class="gphoto gphoto-placeholder"><span>Photo coming soon</span></div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} — TheExactMatch</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;1,500&family=Jost:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#152238;--navy2:#1e2f4d;--gold:#c9a227;--bronze:#8a6a12;--cream:#f7f4ee;--white:#fff;--ink:#1a1a1a;--border:rgba(21,34,56,.12);--muted:#5b5b5b;--status-good:#2f7a4f}
html,body{background:var(--cream)}
body{font-family:'Jost',sans-serif;color:var(--ink);font-weight:300;font-size:.92rem}
h1,h2,h3{font-family:'Playfair Display',serif;font-weight:500;color:var(--ink)}
.page{max-width:760px;margin:0 auto;padding:0 0 4rem}
.backlink{display:block;padding:1.2rem 1.5rem 0;font-size:.74rem;color:var(--muted);text-decoration:none}
.backlink:hover{color:var(--ink)}
header.vhead{padding:1.4rem 1.5rem 1.8rem;border-bottom:4px solid ${accent}}
.option-badge{display:inline-flex;align-items:center;gap:.4rem;font-size:.68rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--white);background:${accent};padding:.3rem .8rem;border-radius:20px;margin-bottom:1rem}
h1.vname{font-size:clamp(1.5rem,3.4vw,2rem);line-height:1.25;margin-bottom:.5rem}
.vdealer{font-size:.82rem;color:var(--muted)}
.specs-bar{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--border);border:1px solid var(--border);margin:1.4rem 1.5rem 0;border-radius:4px;overflow:hidden}
.spec-tile{background:var(--white);padding:1.1rem 1.2rem}
.spec-tile-label{font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--bronze);margin-bottom:.35rem}
.spec-tile-value{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:600;color:var(--navy);line-height:1.15}
.spec-tile-value .unit{font-family:'Jost',sans-serif;font-size:.7rem;font-weight:500;color:var(--muted);margin-left:.25rem}
.photos-toggle{display:block;width:calc(100% - 3rem);margin:1.6rem 1.5rem 0;padding:.85rem;background:var(--white);border:1px solid var(--border);border-radius:4px;font-family:'Jost',sans-serif;font-weight:600;font-size:.78rem;letter-spacing:.04em;color:var(--navy);cursor:pointer;text-align:center}
.photos-toggle:hover{border-color:var(--gold)}
.gallery{display:none;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.5rem;margin:.7rem 1.5rem 0}
.gallery.open{display:grid}
.gallery img,.gphoto{width:100%;height:200px;object-fit:cover;border-radius:4px;background:var(--cream);display:block}
.gphoto-placeholder{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.8rem;font-style:italic;grid-column:1/-1}
.section{margin:2rem 1.5rem 0}
.section-title{font-size:.68rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--bronze);margin-bottom:.9rem;padding-bottom:.6rem;border-bottom:1px solid var(--border)}
.spec-rows{display:flex;flex-direction:column}
.spec-row{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--border);font-size:.85rem}
.spec-row:last-child{border-bottom:none}
.spec-row-label{color:var(--muted)}
.spec-row-value{color:var(--ink);font-weight:500;text-align:right}
.features-list{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.9rem}
.feature-chip{font-size:.72rem;color:var(--navy);background:var(--cream);border:1px solid var(--border);padding:.35rem .75rem;border-radius:20px}
.jeff-take{background:var(--white);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:4px;padding:1.3rem 1.4rem}
.jeff-take p{font-size:.9rem;line-height:1.7;color:var(--ink)}
.jeff-signoff{font-size:.78rem;color:var(--muted);margin-top:.8rem;font-style:italic}
.finance-meta{display:flex;flex-wrap:wrap;gap:1.2rem;margin-bottom:1rem;font-size:.78rem;color:var(--muted)}
.finance-meta b{color:var(--ink);font-weight:600}
.finance-table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--white)}
table.finance-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.finance-table th,.finance-table td{padding:.75rem 1rem;text-align:right;font-size:.85rem;white-space:nowrap}
.finance-table th{background:var(--navy);color:var(--cream);font-size:.65rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.finance-table th:first-child,.finance-table td:first-child{text-align:left}
.finance-table td:first-child{font-weight:600;color:var(--ink);background:var(--cream)}
.finance-table tbody tr:not(:last-child) td{border-bottom:1px solid var(--border)}
.finance-table td.stated-col{color:var(--navy);font-weight:700;background:rgba(201,162,39,.08)}
.finance-table th.stated-col{background:var(--navy2)}
.finance-note{font-size:.72rem;color:var(--muted);margin-top:.8rem;line-height:1.6}
.target-box{background:var(--navy);color:var(--white);border-radius:4px;padding:1.2rem 1.4rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;margin-bottom:1.1rem}
.target-label{font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--gold)}
.target-value{font-family:'Playfair Display',serif;font-size:1.35rem;font-weight:600;margin-top:.25rem}
.target-vs{font-size:.75rem;color:rgba(247,244,238,.6);text-align:right}
.tactics-list{display:flex;flex-direction:column;gap:.9rem}
.tactic{display:flex;gap:.8rem;align-items:flex-start}
.tactic-num{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:var(--cream);border:1.5px solid var(--bronze);color:var(--bronze);font-size:.72rem;font-weight:700;display:flex;align-items:center;justify-content:center}
.tactic-text{font-size:.85rem;line-height:1.6;color:var(--ink);padding-top:.1rem}
.tactic-text b{color:var(--navy)}
.wg-intro{font-size:.88rem;line-height:1.7;color:var(--ink);margin-bottom:1.3rem}
.wg-steps{display:flex;flex-direction:column;gap:0;margin-bottom:1.2rem}
.wg-step{display:flex;gap:1rem;padding:.85rem 0;border-bottom:1px solid var(--border)}
.wg-step:last-child{border-bottom:none}
.wg-step-num{flex-shrink:0;width:26px;height:26px;border-radius:50%;background:var(--navy);color:var(--gold);font-family:'Playfair Display',serif;font-size:.8rem;font-weight:600;display:flex;align-items:center;justify-content:center}
.wg-step-text{font-size:.85rem;line-height:1.55;color:var(--ink);padding-top:.15rem}
.wg-value-callout{background:rgba(201,162,39,.1);border-left:3px solid var(--gold);border-radius:4px;padding:1rem 1.2rem;font-size:.85rem;line-height:1.65;color:var(--ink)}
.wg-value-callout b{color:var(--bronze)}
.listing-link-wrap{text-align:center;padding:1.5rem 0 .5rem}
.listing-link{font-size:.72rem;color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.listing-link:hover{color:var(--ink)}
.action-bar{background:var(--white);border-top:1px solid var(--border);margin:1.5rem 1.5rem 0;padding:1.3rem 0 0;display:flex;flex-direction:column;gap:.7rem}
.action-btn{padding:.9rem;border-radius:4px;font-family:'Jost',sans-serif;font-weight:700;font-size:.78rem;letter-spacing:.05em;text-align:center;cursor:pointer;border:none}
.action-btn.primary{background:var(--gold);color:var(--navy)}
.action-btn.primary:hover{background:#d8b23c}
.action-btn.primary:disabled{background:var(--status-good);color:var(--white);cursor:default}
.action-btn.secondary{background:var(--navy);color:var(--white)}
.action-btn.secondary:hover{background:var(--navy2)}
.conf-overlay{position:fixed;inset:0;background:rgba(21,34,56,.6);display:none;align-items:center;justify-content:center;padding:1.2rem;z-index:50}
.conf-overlay.open{display:flex}
.conf-box{background:var(--white);border-radius:6px;padding:2rem 1.8rem;max-width:440px;width:100%;max-height:90vh;overflow-y:auto}
.conf-title{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:500;color:var(--ink);margin-bottom:.8rem}
.conf-body{font-size:.88rem;line-height:1.7;color:var(--ink);margin-bottom:1rem}
.conf-recap{background:var(--cream);border-radius:4px;padding:1rem 1.2rem;margin-bottom:1rem}
.conf-recap-title{font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--bronze);margin-bottom:.6rem}
.conf-recap ul{list-style:none;display:flex;flex-direction:column;gap:.4rem}
.conf-recap li{font-size:.82rem;color:var(--ink);padding-left:1rem;position:relative}
.conf-recap li::before{content:'';position:absolute;left:0;top:.5em;width:5px;height:5px;border-radius:50%;background:var(--gold)}
.conf-fee-box{display:flex;justify-content:space-between;align-items:center;background:var(--navy);color:var(--white);border-radius:4px;padding:1rem 1.2rem;margin-bottom:1rem}
.conf-fee-label{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold)}
.conf-fee-value{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:600;margin-top:.2rem}
.conf-fee-note{font-size:.72rem;color:var(--muted);line-height:1.6;margin-bottom:1.2rem}
.conf-close{width:100%;padding:.85rem;background:var(--gold);color:var(--navy);border:none;border-radius:4px;font-family:'Jost',sans-serif;font-weight:700;font-size:.78rem;letter-spacing:.05em;cursor:pointer;margin-bottom:.6rem}
.conf-close:hover{background:#d8b23c}
.conf-cancel{width:100%;padding:.7rem;background:none;border:none;color:var(--muted);font-family:'Jost',sans-serif;font-size:.76rem;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.conf-cancel:hover{color:var(--ink)}
.hidden{display:none}
@media (min-width:600px){ .action-bar{flex-direction:row} .action-btn{flex:1} .specs-bar{grid-template-columns:repeat(3,1fr)} }
</style>
</head>
<body>
<div class="page">
  <a class="backlink" href="https://theexactmatch.com/reports/${escapeHtml(report.report_code)}">&larr; Back to all your options</a>

  <header class="vhead">
    ${vehicleCount > 1 ? `<div class="option-badge">Option ${escapeHtml(v.position)}</div>` : ''}
    <h1 class="vname">${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)} ${escapeHtml(v.trim)}</h1>
    ${!sourcing && (v.dealer_name || v.dealer_city) ? `<div class="vdealer">${v.dealer_name ? escapeHtml(v.dealer_name) : ''}${v.dealer_name && v.dealer_city ? ', ' : ''}${v.dealer_city ? escapeHtml(v.dealer_city) + (v.dealer_state ? ', ' + escapeHtml(v.dealer_state) : '') : ''}</div>` : ''}
  </header>

  ${sourcing ? `
  <div class="section"><div class="jeff-take"><p>This one's still being sourced. I'll have full details for you shortly.</p></div></div>
  ` : `
  <div class="specs-bar">
    <div class="spec-tile"><div class="spec-tile-label">This Listing</div><div class="spec-tile-value">${v.price != null ? '$' + Number(v.price).toLocaleString() : '—'}</div></div>
    <div class="spec-tile"><div class="spec-tile-label">MPG</div><div class="spec-tile-value">${v.city_mpg || '—'}<span class="unit">city</span> / ${v.highway_mpg || '—'}<span class="unit">hwy</span></div></div>
    <div class="spec-tile"><div class="spec-tile-label">Cargo Space</div><div class="spec-tile-value" style="font-size:1rem">${v.cargo_space ? escapeHtml(v.cargo_space) : '—'}</div></div>
    <div class="spec-tile"><div class="spec-tile-label">Safety</div><div class="spec-tile-value" style="font-size:1rem">${v.safety_rating ? escapeHtml(v.safety_rating) : '—'}</div></div>
  </div>

  ${photos.length ? `
  <button class="photos-toggle" id="photos-toggle">View Photos <span>(${photos.length})</span></button>
  <div class="gallery" id="gallery">${gallery}</div>
  ` : ''}

  ${(specRows.length || features.length) ? `
  <div class="section">
    <div class="section-title">Vehicle Specs</div>
    ${specRows.length ? `<div class="spec-rows">${specRows.map(([label, value]) => `<div class="spec-row"><span class="spec-row-label">${escapeHtml(label)}</span><span class="spec-row-value">${escapeHtml(value)}</span></div>`).join('')}</div>` : ''}
    ${features.length ? `<div class="features-list">${features.map(f => `<span class="feature-chip">${escapeHtml(f)}</span>`).join('')}</div>` : ''}
  </div>
  ` : ''}

  ${v.rationale ? `
  <div class="section">
    <div class="section-title">Jeff's Take</div>
    <div class="jeff-take">
      <p>${escapeHtml(v.rationale)}</p>
      <div class="jeff-signoff">Jeff</div>
    </div>
  </div>
  ` : ''}

  ${financing ? `
  <div class="section">
    <div class="section-title">Estimated Payments</div>
    <div class="finance-meta">
      <span>Credit tier: <b>${escapeHtml(financing.tier.label)} (${Math.round(financing.tier.apr * 100)}% APR)</b></span>
      <span>Stated down payment: <b>$${financing.downOptions[1].toLocaleString()}</b></span>
      <span>Out-the-door before down payment: <b>$${financing.otd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> <span style="color:var(--muted)">(price + 6.25% TX tax + $300 fees)</span></span>
    </div>
    <div class="finance-table-wrap">
      <table class="finance-table">
        <thead>
          <tr>
            <th>Term</th>
            <th>$${financing.downOptions[0].toLocaleString()} down</th>
            <th class="stated-col">$${financing.downOptions[1].toLocaleString()} down</th>
            <th>$${financing.downOptions[2].toLocaleString()} down</th>
          </tr>
        </thead>
        <tbody>
          ${financing.rows.map(row => `
          <tr>
            <td>${row.term} months</td>
            <td>$${row.payments[0].toFixed(2)}/mo</td>
            <td class="stated-col">$${row.payments[1].toFixed(2)}/mo</td>
            <td>$${row.payments[2].toFixed(2)}/mo</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="finance-note">These are estimates only. Your actual rate, term, and payment depend on lender approval and may vary from what's shown here.</div>
  </div>
  ` : ''}

  <div class="section">
    <div class="section-title">Negotiation Tactics</div>
    ${target ? `
    <div class="target-box">
      <div><div class="target-label">Your Target</div><div class="target-value">$${target.low.toLocaleString()} &ndash; $${target.high.toLocaleString()}</div></div>
      <div class="target-vs">vs. $${Number(v.price).toLocaleString()} asking</div>
    </div>` : ''}
    <div class="tactics-list">
      <div class="tactic"><div class="tactic-num">1</div><div class="tactic-text">Ask how long it's been on the lot. <b>The longer it's sat, the more room the dealer usually has to move on price</b>, since they're paying to keep it there.</div></div>
      <div class="tactic"><div class="tactic-num">2</div><div class="tactic-text">Get the <b>full out-the-door price in writing</b> before you say a word about trade-in or financing. Negotiate the vehicle price as its own conversation.</div></div>
      <div class="tactic"><div class="tactic-num">3</div><div class="tactic-text"><b>Don't let financing and trade-in get bundled</b> into the same number as the car. Handle each as a separate line item so you can see exactly what you're paying for what.</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">White Glove Service</div>
    <div class="wg-intro">Most buyers spend 4-6 hours on this: researching, calling dealers, negotiating, then doing it all again for financing and paperwork, usually solo against a sales team that does this every day. If you'd rather not, I'll do it for you.</div>
    <div class="wg-steps">
      <div class="wg-step"><div class="wg-step-num">1</div><div class="wg-step-text">Schedule your test drive, often right at your home.</div></div>
      <div class="wg-step"><div class="wg-step-num">2</div><div class="wg-step-text">Negotiate on your behalf to your target price and payment.</div></div>
      <div class="wg-step"><div class="wg-step-num">3</div><div class="wg-step-text">Handle your trade-in valuation.</div></div>
      <div class="wg-step"><div class="wg-step-num">4</div><div class="wg-step-text">Coordinate financing and paperwork before you ever sign anything.</div></div>
      <div class="wg-step"><div class="wg-step-num">5</div><div class="wg-step-text">Arrange delivery, if that's easier for you.</div></div>
    </div>
    <div class="wg-value-callout"><b>What you're really getting:</b> the hours back, and someone in your corner negotiating for you, not the dealer.</div>
  </div>

  ${v.vdp_url ? `<div class="listing-link-wrap"><a class="listing-link" href="${escapeHtml(v.vdp_url)}" target="_blank" rel="noopener">View original listing (dealer site)</a></div>` : ''}

  <div class="action-bar">
    <button class="action-btn primary" id="interested-btn" data-position="${v.position}" ${v.interested ? 'disabled' : ''}>${v.interested ? '✓ You expressed interest' : "I'm Interested: Send Me to the Dealer"}</button>
    <button class="action-btn secondary" id="wg-btn" data-position="${v.position}">${v.white_glove_requested ? 'White Glove Requested' : 'White Glove Service'}</button>
  </div>
  `}
</div>

<div class="conf-overlay" id="interested-overlay">
  <div class="conf-box">
    <div class="conf-title">Got it.</div>
    <div class="conf-body">I'll connect you directly with <b>${v.dealer_name ? escapeHtml(v.dealer_name) : 'the dealer'}</b> and make sure they know exactly what you're looking for. Expect to hear from me shortly.</div>
    <button class="conf-close" id="interested-close">Close</button>
  </div>
</div>

<div class="conf-overlay" id="wg-overlay">
  <div class="conf-box">
    <div id="wg-proposal">
      <div class="conf-title">White Glove Service</div>
      <div class="conf-body">Here's what I'll personally handle for you, and what it costs.</div>
      <div class="conf-recap">
        <div class="conf-recap-title">What I'm Doing</div>
        <ul>
          <li>Schedule your test drive</li>
          <li>Negotiate on your behalf to your target price</li>
          <li>Handle your trade-in valuation</li>
          <li>Coordinate financing and paperwork</li>
          <li>Arrange delivery if needed</li>
        </ul>
      </div>
      <div class="conf-fee-box">
        <div><div class="conf-fee-label">White Glove Fee</div><div class="conf-fee-value">${fee != null ? '$' + fee.toLocaleString() : "I'll follow up with pricing"}</div></div>
      </div>
      <div class="conf-fee-note">${fee != null ? 'This fee is only due if you move forward, nothing is charged now.' : "This one's outside our standard pricing tiers, so I'll follow up with the right number for you."}</div>
      <button class="conf-close" id="wg-proceed">Yes, Let's Do This</button>
      <button class="conf-cancel" id="wg-cancel">Not Right Now</button>
    </div>
    <div id="wg-confirmed" class="hidden">
      <div class="conf-title">You're all set.</div>
      <div class="conf-body">Got it. I'll follow up with you shortly to get started.</div>
      <button class="conf-close" id="wg-close">Close</button>
    </div>
  </div>
</div>

<script>
(function(){
  var API = 'https://theexactmatch-dealer-api.jeffakrong26.workers.dev/api/public/reports/${escapeHtml(report.report_code)}/vehicles/';
  var photosToggle = document.getElementById('photos-toggle');
  if (photosToggle) {
    photosToggle.addEventListener('click', function() {
      var gallery = document.getElementById('gallery');
      var open = gallery.classList.toggle('open');
      this.innerHTML = open ? 'Hide Photos' : 'View Photos <span>(${photos.length})</span>';
    });
  }

  var interestedBtn = document.getElementById('interested-btn');
  if (interestedBtn) {
    interestedBtn.addEventListener('click', async function() {
      if (this.disabled) return;
      document.getElementById('interested-overlay').classList.add('open');
      try {
        await fetch(API + this.dataset.position + '/interest', { method: 'POST' });
        this.disabled = true;
        this.textContent = '✓ You expressed interest';
      } catch (e) {}
    });
  }
  document.getElementById('interested-close').addEventListener('click', function() {
    document.getElementById('interested-overlay').classList.remove('open');
  });

  var wgBtn = document.getElementById('wg-btn');
  if (wgBtn) {
    wgBtn.addEventListener('click', function() {
      document.getElementById('wg-proposal').classList.remove('hidden');
      document.getElementById('wg-confirmed').classList.add('hidden');
      document.getElementById('wg-overlay').classList.add('open');
    });
  }
  document.getElementById('wg-cancel').addEventListener('click', function() {
    document.getElementById('wg-overlay').classList.remove('open');
  });
  document.getElementById('wg-proceed').addEventListener('click', async function() {
    try { await fetch(API + wgBtn.dataset.position + '/white-glove', { method: 'POST' }); } catch (e) {}
    document.getElementById('wg-proposal').classList.add('hidden');
    document.getElementById('wg-confirmed').classList.remove('hidden');
    if (wgBtn) wgBtn.textContent = 'White Glove Requested';
  });
  document.getElementById('wg-close').addEventListener('click', function() {
    document.getElementById('wg-overlay').classList.remove('open');
  });
})();
</script>
</body></html>`;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const REPORT_CODE_RE = /^(TEM-\d{4}-\d{4})(?:-(.+))?$/;

// ── TEMP diagnostic: market trend graph data-availability check ─────
// Not part of the product — buckets active listings by first-seen month to
// see what a "price trend" line would actually look like with real data.
// Remove after the Screen 2 trend-graph section is validated.
async function renderReportPage(request, env, params) {
  const m = (params.code || '').match(REPORT_CODE_RE);
  if (!m) return htmlResponse(reportNotFoundHtml(), 404);
  const [, reportCode, slug] = m;

  const report = await env.DB.prepare(`
    SELECT find_car_reports.*, find_car_leads.first_name, find_car_leads.last_name,
      find_car_leads.payment_method, find_car_leads.credit_range, find_car_leads.down_payment
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
    return htmlResponse(vehicleDeepDiveHtml(report, vehicle, vehicles.length));
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
  { method: 'DELETE', pattern: '/api/admin/submissions/:id',      handler: adminDeleteSubmission, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/submissions/:id/scrape-listing', handler: adminScrapeSubmissionListing, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/submissions/:id/photo',        handler: adminUploadSubmissionPhoto, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/leads',                 handler: adminLeads, auth: true, admin: true },
  { method: 'DELETE', pattern: '/api/admin/leads/:id',            handler: adminDeleteLead, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/leads/:id/valuation',    handler: adminGetLeadValuation, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/leads/:id/valuation/photo/:slot', handler: adminUploadValuationPhoto, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/leads/:id/send-valuation',   handler: adminSendValuationEmail, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/leads/:id/save-valuation',   handler: adminSaveValuationEdits, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/find-leads',             handler: adminFindLeads, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/contact-messages',       handler: adminContactMessages, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/public/find-car-lead',         handler: submitFindCarLead },
  { method: 'POST',  pattern: '/api/public/sell-car-lead',         handler: submitSellCarLead },
  { method: 'POST',  pattern: '/api/public/sell/:token/photo/:slot', handler: uploadSellPhoto },
  { method: 'POST',  pattern: '/api/public/sell/:token/complete',    handler: completeSellPhotos },
  { method: 'POST',  pattern: '/api/public/sell/:token/ready',       handler: publicMarkReadyToSell },
  { method: 'POST',  pattern: '/api/public/contact-message',       handler: submitContactMessage },
  { method: 'GET',   pattern: '/api/admin/dealers',               handler: adminDealers, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/notification-counts',                              handler: adminNotificationCounts, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/notification-counts/:section/items/:itemId/seen',  handler: adminMarkItemSeen, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/dealers/:id',           handler: adminUpdateDealer, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/dealers/:id/autodev-lookup', handler: adminAutodevDealerLookup, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/invites',                handler: adminGenerateInvite, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/invites',                handler: adminListInvites, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/dealer/invites/:token',        handler: validateInvite },
  { method: 'POST',  pattern: '/api/dealer/signup',                handler: dealerSignup },
  { method: 'GET',   pattern: '/api/admin/debug/autodev-test',         handler: debugAutodevTest, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/reports',                     handler: adminListReports, auth: true, admin: true },
  { method: 'GET',   pattern: '/api/admin/reports/:code',                handler: adminGetReport, auth: true, admin: true },
  { method: 'PATCH', pattern: '/api/admin/reports/:code/vehicles/:position', handler: adminUpdateReportVehicle, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/approve',        handler: adminApproveReport, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/vehicles/:position/photo', handler: adminUploadReportVehiclePhoto, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/admin/reports/:code/vehicles/:position/scrape-listing', handler: adminScrapeListingUrl, auth: true, admin: true },
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/interest', handler: publicExpressReportInterest },
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/white-glove', handler: publicRequestWhiteGlove },
  { method: 'POST',  pattern: '/api/public/reports/:code/vehicles/:position/ready', handler: publicReadyToMoveForward },
];

async function cleanupStaleRecords(env) {
  const subsDeleted = await env.DB.prepare(`
    DELETE FROM inventory_submissions
    WHERE status IN ('pending', 'rejected') AND created_at < datetime('now', '-45 days')
  `).run();

  const { results: staleLeads } = await env.DB.prepare(`
    SELECT sell_my_car_leads.id
    FROM sell_my_car_leads
    LEFT JOIN vehicle_valuations ON vehicle_valuations.lead_id = sell_my_car_leads.id
    WHERE sell_my_car_leads.created_at < datetime('now', '-45 days')
      AND (vehicle_valuations.status IS NULL OR vehicle_valuations.status != 'valued')
  `).all();

  for (const lead of staleLeads) {
    await deleteSellCarLead(env, lead.id).catch(err => console.error('cleanup failed for lead', lead.id, err));
  }

  console.log(`[cleanup] removed ${subsDeleted.meta.changes} stale submissions, ${staleLeads.length} stale sell-car leads`);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);

    if (request.method === 'GET' || request.method === 'HEAD') {
      const photoParams = matchPath('/reports/photos/:code/:position', url.pathname);
      if (photoParams) return servePhoto(env, photoParams, request.method);

      const submissionPhotoParams = matchPath('/submissions/photos/:id', url.pathname);
      if (submissionPhotoParams) return serveSubmissionPhoto(env, submissionPhotoParams, request.method);

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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupStaleRecords(env));
  },

  async queue(batch, env) {
    if (batch.queue.endsWith('-dlq')) {
      // Every retry has already been exhausted for these — the only thing left
      // to do is make sure a human finds out, since nothing else will surface it.
      for (const message of batch.messages) {
        const body = message.body;
        await sendBrevoEmail(env, {
          to: 'theexactmatch@gmail.com',
          subject: '⚠️ Background job permanently failed',
          html: brandedEmailHtml(`
            <p>A queued job exhausted all retries and was moved to the dead-letter queue — it will <strong>not</strong> run again automatically.</p>
            <p><strong>Type:</strong> ${escapeHtml(body?.type || 'unknown')}<br/>
            <strong>Lead ID:</strong> ${escapeHtml(body?.leadId ?? 'unknown')}</p>
            <p>Check the Cloudflare dashboard's Workers Logs for theexactmatch-dealer-api around this time for the actual error, then re-trigger manually if needed.</p>
          `),
        }).catch(err => console.error('dead-letter alert email failed', body, err));
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        const body = message.body;
        if (body.type === 'find_car_report') {
          await generateReportForLead(env, body.leadId);
        } else if (body.type === 'sell_car_valuation') {
          await generateValuationForLead(env, body.leadId, body.input);
        } else if (body.type === 'dealer_welcome_email') {
          await sendBrevoTemplateEmail(env, {
            to: body.to,
            templateId: DEALER_WELCOME_TEMPLATE_ID,
            params: { FIRSTNAME: body.firstName },
          });
        } else {
          console.error('unknown queue job type', body.type);
        }
        message.ack();
      } catch (err) {
        console.error('queue job failed', message.body, err);
        message.retry();
      }
    }
  },
};
