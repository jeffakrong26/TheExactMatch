// Backend for the personal daily build-tracker at /build-tracker. Each day
// pulls the next unfinished items off a master backlog rather than resetting
// to a fixed list, so the tracker reflects real progress toward Phase 1.
//
// Storage is a single KV namespace (TEM_TASKS):
//   master-backlog    - the ordered Phase 1 backlog, with permanent done flags
//   daily-log:{date}  - the specific items shown/completed on that date
//
// `date` is always supplied by the client (its own local YYYY-MM-DD) rather
// than computed here — the Worker's clock has no timezone context for the
// one person who uses this page.

const DAILY_PULL_COUNT = 6;

const DEFAULT_BACKLOG = [
  'Finish homepage refresh (redesign)',
  'Check redesign against AI-tell checklist (no decorative numbered markers, no cream+terracotta drift, no generic hero formula)',
  'Apply redesign direction to Sell My Car page',
  'Apply redesign direction to About page',
  'Apply redesign direction to remaining key pages',
  'Send per-URL migration prompt to Claude Code',
  'Verify migration: each URL serves only its own content, one H1 per page',
  'Send 3 quick-wins prompt (form reorder, popup exit-intent, homepage trust pass)',
  'Install analytics + Search Console + submit sitemap',
  'Publish national "Car Buying Concierge" page',
  'Publish brand sell page: Ferrari',
  'Publish brand sell page: Bentley',
  'Publish brand sell page: Porsche',
  'Publish brand sell page: Lamborghini',
  'Publish brand sell page: McLaren',
  'Publish remaining brand sell pages (Rolls Royce, Tesla, classic cars)',
  'Google Business Profile setup + review request flow',
  'Schema rollout (Organization, LocalBusiness, Person, Service, FAQ)',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function getBacklog(env) {
  const raw = await env.TEM_TASKS.get('master-backlog');
  if (raw) return JSON.parse(raw);
  const seeded = DEFAULT_BACKLOG.map((text, i) => ({ id: `b${i + 1}`, text, done: false }));
  await env.TEM_TASKS.put('master-backlog', JSON.stringify(seeded));
  return seeded;
}

async function saveBacklog(env, backlog) {
  await env.TEM_TASKS.put('master-backlog', JSON.stringify(backlog));
}

async function getDailyLog(env, date) {
  const raw = await env.TEM_TASKS.get(`daily-log:${date}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveDailyLog(env, date, log) {
  await env.TEM_TASKS.put(`daily-log:${date}`, JSON.stringify(log));
}

// Generates (and persists) a date's list the first time it's requested; every
// later call for the same date returns the same list untouched, so reopening
// the page mid-day doesn't reshuffle or reset anything.
async function getOrCreateDailyLog(env, date) {
  const existing = await getDailyLog(env, date);
  if (existing) return existing;

  const backlog = await getBacklog(env);
  const items = backlog
    .filter(item => !item.done)
    .slice(0, DAILY_PULL_COUNT)
    .map(item => ({ id: item.id, text: item.text, done: false, source: 'backlog' }));

  const log = { date, items };
  await saveDailyLog(env, date, log);
  return log;
}

function requireDate(url) {
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
}

export async function handleTasksRequest(request, env, url) {
  const path = url.pathname;

  if (path === '/api/tasks/today' && request.method === 'GET') {
    const date = requireDate(url);
    if (!date) return json({ error: 'missing or invalid ?date=YYYY-MM-DD' }, 400);
    const log = await getOrCreateDailyLog(env, date);
    return json(log);
  }

  if (path === '/api/tasks/toggle' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const date = body?.date;
    const id = body?.id;
    if (!date || !id) return json({ error: 'body must be { date, id }' }, 400);

    const log = await getOrCreateDailyLog(env, date);
    const item = log.items.find(t => t.id === id);
    if (!item) return json({ error: "no such task in that day's list" }, 404);

    item.done = !item.done;
    await saveDailyLog(env, date, log);

    // Completing a backlog-sourced item retires it from the backlog for good.
    // Unchecking it later the same day is just fixing a mis-click, so it must
    // NOT un-retire an already-completed backlog item — hence the one-way
    // `!backlogItem.done` guard below rather than mirroring item.done.
    if (item.source === 'backlog' && item.done) {
      const backlog = await getBacklog(env);
      const backlogItem = backlog.find(b => b.id === id);
      if (backlogItem && !backlogItem.done) {
        backlogItem.done = true;
        await saveBacklog(env, backlog);
      }
    }

    return json(log);
  }

  if (path === '/api/tasks/add' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const date = body?.date;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!date || !text) return json({ error: 'body must be { date, text }' }, 400);

    const log = await getOrCreateDailyLog(env, date);
    log.items.push({
      id: `adhoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      done: false,
      source: 'adhoc',
    });
    await saveDailyLog(env, date, log);
    return json(log);
  }

  const deleteMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const date = requireDate(url);
    if (!date) return json({ error: 'missing or invalid ?date=YYYY-MM-DD' }, 400);

    // Removes the item from this date's list only — it is never a
    // backlog-completion signal, so an unfinished backlog item removed today
    // stays eligible to be pulled again on a future day.
    const log = await getOrCreateDailyLog(env, date);
    log.items = log.items.filter(t => t.id !== id);
    await saveDailyLog(env, date, log);
    return json(log);
  }

  return json({ error: 'not found' }, 404);
}
