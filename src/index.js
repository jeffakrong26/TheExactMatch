// Site worker for theexactmatch.com.
//
// index.html is a single-page app: it holds a `.page` div per view and
// showPage() toggles which one is `active`. That reads fine for humans but
// gives every view the same URL, so a crawler only ever sees the default
// Home view — and the AI crawlers we explicitly invite in robots.txt
// (GPTBot, PerplexityBot, ClaudeBot) generally don't run JS at all, so
// client-side routing alone would still serve them the wrong content on
// every path.
//
// This worker gives each view a real URL and rewrites the HTML per path, so
// the correct page div is already active and the title/description/canonical
// are correct in the *initial* response, with no JS required. index.html stays
// the single source of truth — nothing is duplicated.
//
// Static assets are served before this worker runs (the Wrangler default), so
// only paths with no matching file reach us. `/` therefore never hits the
// worker — index.html's own <head> is already the homepage's metadata, which
// is why the defaults there must stay in sync with VIEWS[0] below.

// Personal daily build-tracker at /build-tracker (a static asset — see
// build-tracker.html). Its fetch() calls hit these endpoints for state.
import { handleTasksRequest } from './tasks.js';

// Apex, not www. The Worker's custom domain is bound to the apex only —
// www.theexactmatch.com resolves to Cloudflare but has no origin behind it and
// returns 522, so canonicalizing there would point every URL at a dead host.
// If www is ever attached or redirected, this is the one line to change.
const ORIGIN = 'https://theexactmatch.com';

// Bump when the page copy meaningfully changes. A lastmod that never moves is
// worse than none at all — search engines learn to distrust it — so this is
// deliberately a value you edit, not a build timestamp that churns on every
// deploy and claims every page changed.
const LASTMOD = '2026-07-31';

// The single place a public route is defined. Both the HTML rewriting and
// sitemap.xml are generated from this list, so adding a view can't silently
// leave the sitemap stale.
const VIEWS = [
  {
    path: '/',
    page: 'home',
    lastmod: '2026-08-25',
    title: "TheExactMatch — We Don't List Cars. We Find Yours.",
    description:
      "Tell us what you want — we search our dealer network, negotiate the price, and deliver your exact match. Free, no obligation.",
  },
  {
    // Find My Car used to live at `/` — see index.html's own <head>, which
    // this view's title/description otherwise mirror. It moved here when the
    // homepage became its own dedicated landing page.
    path: '/find-my-car',
    page: 'find',
    lastmod: '2026-08-25',
    title: 'Find My Car — Search, Negotiate & Deliver | TheExactMatch',
    description:
      "Tell us what you want and we'll find it. We search our nationwide dealer network and send you 3 curated options within 24 hours. Free, no obligation.",
  },
  {
    path: '/recent-matches',
    page: 'recent-matches',
    lastmod: '2026-08-26',
    title: 'Recent Matches — Real Deals We\'ve Closed | TheExactMatch',
    description:
      'Real cars we\'ve found, negotiated, and closed for clients — savings, warranties, and what actually happened on each deal.',
  },
  {
    path: '/sell-my-car',
    page: 'sell',
    lastmod: '2026-08-27',
    title: 'Sell My Car — Multiple Real Offers, Not One Lowball | TheExactMatch',
    description:
      "Skip the single instant-offer lowball. We send your car to multiple dealers actively buying your segment and bring back real, competing offers within 24 hours — you choose, or walk away.",
  },
  {
    path: '/how-it-works',
    page: 'how',
    title: 'How It Works — Find My Car & Sell My Car | TheExactMatch',
    description:
      "Two services, one goal — making your car transaction effortless. Here's exactly how Find My Car and Sell My Car work, step by step.",
  },
  {
    path: '/about',
    page: 'about',
    lastmod: '2026-08-27',
    title: "About Jeff Akrong — Dealership Insider Turned Buyer's Advocate | TheExactMatch",
    description:
      "Jeff Akrong spent years selling for Audi, Mercedes-Benz, Aston Martin, Rolls-Royce and Bentley. Now he runs The Exact Match — the same insider playbook, entirely on the buyer's side, for free.",
    // Role-wrapped worksFor (schema.org/Role) rather than plain Organization
    // entries — it's the documented pattern for qualifying a relationship
    // with a title and date range, and it's what lets Exclusive Auto
    // Services read as a distinct "Founder" entry rather than blending in
    // with the two employee roles that follow it.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: 'Jeff Akrong',
      alternateName: 'Jeff',
      jobTitle: 'Founder',
      url: 'https://theexactmatch.com/about',
      sameAs: ['https://www.linkedin.com/in/jeffrey-akrong-a80488107'],
      worksFor: [
        {
          '@type': 'Role',
          roleName: 'Founder',
          startDate: '2018',
          endDate: '2022',
          worksFor: {
            '@type': 'Organization',
            name: 'Exclusive Auto Services',
            description: 'Exotic car rental fleet management, including facilitating fleet vehicle sales and purchases, plus private-party buying for clients seeking hard-to-find exotics.',
          },
        },
        {
          '@type': 'Role',
          roleName: 'Brand Specialist',
          startDate: '2023',
          endDate: '2024',
          worksFor: {
            '@type': 'Organization',
            name: 'HiTech Motorcars',
            description: 'Covered the luxury collection: Audi, Porsche, Aston Martin, Rolls-Royce, Bentley.',
          },
        },
        {
          '@type': 'Role',
          roleName: 'Sales Consultant',
          startDate: '2024',
          endDate: '2025',
          worksFor: {
            '@type': 'Organization',
            name: 'Swickard Automotive',
            description: 'Mercedes-Benz.',
          },
        },
      ],
      hasCredential: [
        { '@type': 'EducationalOccupationalCredential', credentialCategory: 'Certification', name: 'Certified Brand Ambassador — Audi' },
        { '@type': 'EducationalOccupationalCredential', credentialCategory: 'Certification', name: 'Certified Brand Ambassador — Mercedes-Benz' },
      ],
      award: 'Sales award recipient at Audi',
    },
  },
  {
    path: '/weekly-finds',
    page: 'weekly',
    title: "Jeff's Weekly Deals — Free Car Newsletter | TheExactMatch",
    description:
      'Hand-picked vehicles delivered to your inbox every week — luxury, exotic, trucks and hidden gems under $50K. No fluff, just real opportunities.',
  },
  {
    path: '/contact',
    page: 'contact',
    title: 'Contact — Talk Cars With Us | TheExactMatch',
    description:
      'Have a question, want to know more about White Glove service, or just want to talk through your situation? Reach out — we respond fast.',
  },
  {
    path: '/how-to-negotiate-car-price',
    page: 'guide-negotiate',
    lastmod: '2026-07-31',
    title: 'How to Negotiate a Car Price: The Complete Guide | The Exact Match',
    description:
      'Real negotiation tactics from a car buying concierge — what actually works at the dealership, what to say, and the mistakes that cost you thousands.',
    // Worded identically to the on-page FAQ — see #page-guide-negotiate in
    // index.html. Keep both in sync; mismatched structured data is a
    // manual-action risk, not a boost.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Should I tell the dealer my budget?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "Not as a monthly payment — that number is exactly what lets a dealer stretch your loan term to hit it while the total cost climbs. If you share anything, share it as an out-the-door price ceiling. Even then, you're under no obligation to volunteer it before you've heard their number first.",
          },
        },
        {
          '@type': 'Question',
          name: 'Is it better to negotiate in person or over email/phone?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Email or phone, when you can manage it. It removes the in-person pressure tactics, gives you time to think instead of answering on the spot, and lets you get a written out-the-door number from more than one dealer before you ever walk onto a lot. Save the in-person visit for once the price is essentially settled.',
          },
        },
        {
          '@type': 'Question',
          name: "How much can you realistically negotiate off a car's price?",
          acceptedAnswer: {
            '@type': 'Answer',
            text: "It varies more than most people expect — by model, by season, and by how long that specific car has sat on the lot. A popular new model in high demand may have very little room. An aged-inventory unit near the end of the model year, or a used car that's been sitting for months, can have a great deal more. There's no honest universal percentage; the car's own sales history is the real answer.",
          },
        },
        {
          '@type': 'Question',
          name: 'Should I negotiate the trade-in and new car price together or separately?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Separately, always. Agree on what you\'re paying for the car you\'re buying first. Only after that number is settled should the trade-in become its own conversation. Combining them gives the dealer two numbers to move against each other instead of one you can hold them to.',
          },
        },
      ],
    },
  },
  {
    path: '/guides',
    page: 'guides',
    lastmod: '2026-08-23',
    title: 'Car Buying Guides | The Exact Match',
    description:
      "In-depth model guides — trims, pricing trends, and what actually matters when you're shopping for a specific car.",
  },
  {
    path: '/guides/audi-r8',
    page: 'guide-audi-r8',
    lastmod: '2026-08-23',
    title: 'Audi R8 Buying Guide: All Trims & Pricing Trends | The Exact Match',
    description:
      'Every Audi R8 trim explained — V8, V10, Performante, manual vs S-tronic — with real market positioning and what to look for.',
    // Worded identically to the on-page FAQ — see #page-guide-audi-r8 in
    // index.html. Keep both in sync; mismatched structured data is a
    // manual-action risk, not a boost.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Which R8 trim holds value best?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "The V10 Plus / V10 Performance halo trim has generally held its value best, simply because Audi built far fewer of them than the standard V8 and V10. Manual examples of any R8 add a further layer of value retention on top of that, since manual was only ever offered on Gen 1 cars and demand for it has only grown since Audi dropped it. The base V8 is the softest holder of value — it's the most common R8 on the road and the one enthusiasts chase last.",
          },
        },
        {
          '@type': 'Question',
          name: 'Is the manual worth the premium?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "For resale and collector value, yes — manual R8s (Gen 1 only, 2008–2015) are scarcer than the S tronic and R tronic cars that make up most of the used market, and that scarcity has only become more pronounced since Audi went S-tronic-only for Gen 2. For everyday usability it's a trade-off: you give up some smoothness in traffic and some resale liquidity, since the buyer pool for a 3-pedal exotic is smaller. If you're buying to drive and eventually sell, the manual premium has generally been worth paying; if you just want the easiest ownership experience, S tronic is the more practical choice.",
          },
        },
        {
          '@type': 'Question',
          name: 'V8 vs. V10 — what\'s the real difference?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'More than just horsepower. The V10 is the same basic Lamborghini-derived architecture as the V8 but bored out, and it brings a noticeably different soundtrack, a real step up in outright performance, and more prestige within the R8 lineup — most enthusiasts consider the V10 the "real" R8. That comes with higher running costs (tires, brakes, insurance) and a higher purchase price. The V8 is the more attainable, still-quick way into R8 ownership — and it\'s Gen 1 only, since Audi never brought it back for the second generation.',
          },
        },
        {
          '@type': 'Question',
          name: 'Gen 1 or Gen 2 — which should I buy?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "It depends what you're optimizing for. Gen 1 (2008–2015) is the only place to find a manual, has a more analog driving character, and is generally the cheaper way into ownership. Gen 2 (2017–2023) is quicker across the board, with a sharper chassis and modern interior tech, but it's S tronic only — there's no manual Gen 2 R8. If the manual gearbox matters to you, that decision is effectively made for you.",
          },
        },
      ],
    },
  },
];

// ── City landing pages ────────────────────────────────────────────────
// All five share the single #page-city div in index.html. Only the name
// changes, so they're generated from this list rather than written out five
// times — both here and in the markup, which would otherwise ship five
// near-identical copies inside the document every view already loads.
//
// `possessive` is explicit rather than derived: "Dallas's" vs "Dallas'" is a
// style call, not something to leave to string concatenation.
const CITY_LASTMOD = '2026-07-31';
const CITIES = [
  { slug: 'austin',      name: 'Austin',      possessive: "Austin's" },
  { slug: 'houston',     name: 'Houston',     possessive: "Houston's" },
  { slug: 'san-antonio', name: 'San Antonio', possessive: "San Antonio's" },
  { slug: 'dallas',      name: 'Dallas',      possessive: "Dallas's" },
  { slug: 'el-paso',     name: 'El Paso',     possessive: "El Paso's" },
];

// Worded identically to the on-page FAQ. Structured data that disagrees with
// visible content is a manual-action risk, not a boost — if the copy in
// index.html changes, this must change with it.
const CITY_FAQ = [
  [
    'How much does it cost?',
    "Nothing. There's no fee, no subscription, and no charge for the search. We're paid a commission by the selling dealer when a purchase closes — it comes out of their side rather than being added to yours. If you don't buy, nobody pays anything.",
  ],
  [
    'Do you only source from dealerships, or private sellers too?',
    "Both. Dealer inventory is where most matches come from, but when the right car is a private-party listing we'll pursue it and handle the inspection and paperwork coordination. Restricting the search to dealers only would mean passing over good cars for no reason.",
  ],
  [
    'How long does it usually take?',
    "You'll have your first set of matched options within 24 hours of submitting the form. From there it depends on how specific your requirements are. A common configuration often closes within a few days; a narrow spec — particular trim, particular color combination, low mileage — can take a couple of weeks of watching the market. We'd rather wait for the right car than push you toward a near-miss.",
  ],
];

for (const city of CITIES) {
  VIEWS.push({
    path: `/${city.slug}`,
    page: 'city',
    city,
    lastmod: CITY_LASTMOD,
    title: `Car Buying Concierge in ${city.name}, TX | The Exact Match`,
    description: `Tell us what you want. We find it, negotiate it, and deliver it — anywhere in ${city.name}. The Exact Match handles your entire car search.`,
    // Injected per-route rather than written into index.html, because that
    // file is the body of EVERY view — a FAQPage block living there would
    // claim this FAQ on /, /about and /contact too.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: CITY_FAQ.map(([name, text]) => ({
        '@type': 'Question',
        name,
        acceptedAnswer: { '@type': 'Answer', text },
      })),
    },
  });
}

// ── Brand-specific sell pages ───────────────────────────────────────────
// All 17 share the single #page-sell-brand div in index.html, same
// one-div-many-URLs pattern as #page-city above. Routed under /sell-my-car/
// rather than the /sell/:brand the brief originally asked for — /sell/* is
// already a Cloudflare route pointing this whole path prefix at dealer-api
// (see wrangler.jsonc; it owns /sell/upload/:token, /sell/report/:token,
// /sell/photos/*, /sell/quick-photos/*), so /sell/ferrari would never reach
// this worker at all. Nesting under /sell-my-car/ instead mirrors how
// /guides/audi-r8 already nests under /guides.
//
// Narrowed to exotic/ultra-luxury only — mainstream-luxury brands (Audi,
// BMW, Mercedes-Benz, Lexus, Infiniti, Cadillac, Genesis, Land Rover, Alfa
// Romeo) are exactly what the general Sell My Car flow already handles
// well, so a dedicated page for them wasn't earning its keep. This is the
// same "hero" tier already visually distinguished in the Find My Car
// dealer-network brand grid, plus McLaren/Rolls-Royce/Aston Martin/
// Maserati, which read as exotic/ultra-luxury for the same reason even
// though that grid doesn't call them out separately.
const SELL_BRAND_LASTMOD = '2026-08-27';
const SELL_BRANDS = [
  { slug: 'bentley',       name: 'Bentley' },
  { slug: 'porsche',       name: 'Porsche' },
  { slug: 'ferrari',       name: 'Ferrari' },
  { slug: 'lamborghini',   name: 'Lamborghini' },
  { slug: 'rolls-royce',   name: 'Rolls-Royce' },
  { slug: 'mclaren',       name: 'McLaren' },
  { slug: 'aston-martin',  name: 'Aston Martin' },
  { slug: 'maserati',      name: 'Maserati' },
];

for (const brand of SELL_BRANDS) {
  VIEWS.push({
    path: `/sell-my-car/${brand.slug}`,
    page: 'sell-brand',
    brand,
    lastmod: SELL_BRAND_LASTMOD,
    title: `Sell Your ${brand.name} — Real Offers, Not One Lowball | TheExactMatch`,
    description: `Selling a ${brand.name}? We send it to dealers and specialist buyers actively looking for exactly this, and bring back real, competing offers within 24 hours. Free, no obligation.`,
  });
}

// Standalone HTML files that are already their own real URL. They need no
// rewriting, but they do belong in the sitemap, so they live here rather than
// being hardcoded into the XML.
//
// Deliberately absent: /market (ships its own noindex,nofollow and is an
// internal brief), /marketing (internal collateral), /partner-terms,
// /Dealerportal and /admin/* (auth-gated or boilerplate).
const STATIC_PAGES = [
  { path: '/referral' },
  { path: '/dealerapp' },
];

// Weekly Finds newsletter archive. Each issue is a standalone HTML file at
// /weekly-finds/<slug>, listed in weekly-finds/issues.json.
//
// To publish Issue No. N:
//   1. Add weekly-finds/issue-N.html
//   2. Set its <link rel="canonical"> to
//      https://theexactmatch.com/weekly-finds/issue-N   (apex, no www)
//   3. Append {"slug":"issue-N","title":…,"lastmod":"YYYY-MM-DD"} to
//      weekly-finds/issues.json
//   4. Deploy — the sitemap picks it up with no code change
//
// The manifest exists because the ASSETS binding can only fetch a path it is
// given; it cannot list a directory, so the worker cannot discover issue files
// on its own. Step 3 is therefore load-bearing: an issue that isn't in the
// manifest is still reachable and still indexable, it just won't be advertised
// in the sitemap.
const ISSUES_MANIFEST = '/weekly-finds/issues.json';
const ISSUE_BASE = '/weekly-finds';

// /weeklyfinds is the pre-existing flat URL for Issue No. 1, kept alive as a
// 301 so shared links and any accumulated ranking survive the move to the
// per-issue path. /public/contact-message was never a page — it's the
// dealer-api endpoint path used by the contact form's client-side fetch (see
// index.html), on a different host entirely. Google indexed it anyway
// pre-migration; redirect it here instead of 404ing so crawlers land
// somewhere real.
const REDIRECTS = new Map([
  ['/weeklyfinds', `${ISSUE_BASE}/issue-1`],
  ['/public/contact-message', '/contact'],
]);

const VIEWS_BY_PATH = new Map(VIEWS.map(v => [v.path, v]));

// Reads the newsletter manifest. A missing or malformed manifest degrades to
// "no issues" rather than failing the whole sitemap — a broken JSON edit
// should cost us the archive entries, not every URL on the site.
async function loadIssues(env, origin) {
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}${ISSUES_MANIFEST}`));
    if (!res.ok) return [];
    const parsed = await res.json();
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(i => i && typeof i.slug === 'string' && i.slug);
  } catch (err) {
    console.error('[sitemap] could not read weekly-finds manifest:', err);
    return [];
  }
}

function urlEntry(path, lastmod) {
  return `  <url>\n    <loc>${ORIGIN}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
}

function sitemapXml(issues) {
  const entries = [
    // A view may pin its own lastmod (a landing page added long after the
    // core site shouldn't inherit the site-wide date).
    ...VIEWS.map(v => urlEntry(v.path, v.lastmod || LASTMOD)),
    ...STATIC_PAGES.map(p => urlEntry(p.path, LASTMOD)),
    // Each issue carries its own lastmod: an archive page's real value is that
    // it *doesn't* change, so stamping it with the site-wide date would be a
    // false claim about content that was actually last edited months earlier.
    ...issues.map(i => urlEntry(`${ISSUE_BASE}/${i.slug}`, i.lastmod || LASTMOD)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

// Swaps `active` on/off a class list without disturbing the other classes on
// the element (the Contact nav link also carries `nav-cta`, which must survive).
function withActive(classAttr, isActive) {
  const classes = (classAttr || '').split(/\s+/).filter(c => c && c !== 'active');
  if (isActive) classes.push('active');
  return classes.join(' ');
}

// ── Recent Matches ───────────────────────────────────────────────────
// Match data lives in dealer-api's D1/R2, not here — this worker only calls
// its two public read endpoints (over the DEALER_API service binding, so
// it's an in-process call rather than a real network hop) and renders
// whatever comes back. That's what lets a new match go live from the admin
// panel with no deploy of this worker.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchDealerApiJson(env, path) {
  try {
    const res = await env.DEALER_API.fetch(new Request(`https://internal${path}`));
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[recent-matches] dealer-api call failed', path, err);
    return null;
  }
}

// Teaser (Find My Car) and listing (/recent-matches) cards are deliberately
// identical and light — photo + name/vehicle only, no savings or tags. Both
// link one level shallower than the data they're for: teaser -> the listing,
// listing card -> that match's own detail page.
function recentMatchCardHtml(m, href) {
  const photo = m.photo_url
    ? `<img src="${escapeHtml(m.photo_url)}" alt="${escapeHtml(m.card_title)}" class="rm-photo"/>`
    : `<div class="rm-photo rm-photo-placeholder"><span>Photo coming soon</span></div>`;
  return `<a class="rm-card" href="${href}">${photo}<h3>${escapeHtml(m.card_title)}</h3><div class="rm-vehicle">${escapeHtml(m.vehicle)}</div></a>`;
}

// "Currently Sourcing Buyers For" (Sell My Car) — text-only by design, not a
// card variant that happens to lack a photo: no seller-identifying info is
// collected for this block in the first place (dealer-api's public endpoint
// returns only year/make/model/display_area), so there's nothing to add a
// photo of even if the visual pattern otherwise matches .rm-card.
function sourcingBuyerCardHtml(v) {
  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return `<div class="sb-card"><h3>${escapeHtml(vehicle)}</h3>${v.display_area ? `<div class="sb-area">${escapeHtml(v.display_area)}</div>` : ''}</div>`;
}

// ── Founder card ─────────────────────────────────────────────────────
// One definition, injected verbatim into every .founder-card-slot in the
// document — About's hero, and the trust element beside the Find My Car and
// Sell My Car forms. Editing the photo or the one-line statement here is
// the only edit needed; it can't drift out of sync between pages because
// there's only one copy to begin with. No <img> here on purpose — there is
// no headshot yet, and this is a static, honestly-empty placeholder rather
// than a stock photo standing in for one.
const FOUNDER_CARD_HTML = `<div class="founder-card">
  <div class="founder-card-photo" role="img" aria-label="Jeff Akrong headshot — not yet available"><span>Photo<br/>Coming Soon</span></div>
  <div class="founder-card-body">
    <div class="founder-card-name">Jeff Akrong</div>
    <div class="founder-card-line">Dealership insider turned buyer's advocate — ex-Audi, Mercedes-Benz, Aston Martin, Rolls-Royce &amp; Bentley. Now entirely on your side, free.</div>
    <a class="founder-card-link" href="/about" onclick="return showPage('about')">Meet Jeff &rarr;</a>
  </div>
</div>`;

function renderView(assetResponse, view, injections = {}) {
  const canonical = `${ORIGIN}${view.path}`;

  const rewriter =
    new HTMLRewriter()
      .on('title', {
        element(el) {
          el.setInnerContent(view.title);
        },
      })
      .on('meta[name="description"]', {
        element(el) {
          el.setAttribute('content', view.description);
        },
      })
      .on('meta[property="og:title"]', {
        element(el) {
          el.setAttribute('content', view.title);
        },
      })
      .on('meta[property="og:description"]', {
        element(el) {
          el.setAttribute('content', view.description);
        },
      })
      .on('meta[property="og:url"]', {
        element(el) {
          el.setAttribute('content', canonical);
        },
      })
      .on('link[rel="canonical"]', {
        element(el) {
          el.setAttribute('href', canonical);
        },
      })
      // City substitution for the shared #page-city template. Done on
      // dedicated spans rather than by find-and-replacing text: HTMLRewriter
      // delivers text in arbitrary chunks, so a placeholder token could be
      // split across two callbacks and never match.
      .on('.city-name', {
        element(el) {
          if (view.city) el.setInnerContent(view.city.name);
        },
      })
      .on('.city-possessive', {
        element(el) {
          if (view.city) el.setInnerContent(view.city.possessive);
        },
      })
      // Drop the current city from its own "Also Serving" list.
      .on('.city-crosslinks li', {
        element(el) {
          if (view.city && el.getAttribute('data-city') === view.city.slug) el.remove();
        },
      })
      // Same substitution pattern for the shared #page-sell-brand template.
      .on('.brand-name', {
        element(el) {
          if (view.brand) el.setInnerContent(view.brand.name);
        },
      })
      // The CTA needs the brand as a real query param (?make=Ferrari), not
      // just text content, so the sell form can prefill Make on arrival.
      .on('#brand-cta', {
        element(el) {
          if (view.brand) el.setAttribute('href', `/sell-my-car?make=${encodeURIComponent(view.brand.name)}`);
        },
      })
      .on('.brand-crosslinks li', {
        element(el) {
          if (view.brand && el.getAttribute('data-brand') === view.brand.slug) el.remove();
        },
      })
      // Same founder card everywhere it appears — About's hero, and beside
      // the Find My Car / Sell My Car forms — unconditional on view.page
      // since it's a no-op on any page whose markup has no such slot.
      .on('.founder-card-slot', {
        element(el) {
          el.setInnerContent(FOUNDER_CARD_HTML, { html: true });
        },
      })
      // Route-scoped structured data. `</` is escaped so a future answer
      // containing that sequence can't terminate the script element early.
      .on('head', {
        element(el) {
          if (!view.jsonLd) return;
          const json = JSON.stringify(view.jsonLd).replace(/<\//g, '<\\/');
          el.append(`<script type="application/ld+json">${json}</script>`, { html: true });
        },
      })
      // Move the `active` class off page-find (index.html's default) and onto
      // whichever view this URL is for.
      .on('div.page', {
        element(el) {
          const id = el.getAttribute('id') || '';
          el.setAttribute(
            'class',
            withActive(el.getAttribute('class'), id === `page-${view.page}`)
          );
        },
      })
      // Same for the nav's current-page highlight, so the rendered HTML isn't
      // internally inconsistent (nav saying Find My Car, body showing Contact).
      .on('a[id^="nav-"]', {
        element(el) {
          const id = el.getAttribute('id') || '';
          el.setAttribute(
            'class',
            withActive(el.getAttribute('class'), id === `nav-${view.page}`)
          );
        },
      });

  // Recent Matches content (teaser grid, listing grid, a single match's
  // photo/title/tags) — server-rendered per request from live dealer-api
  // data, same reasoning as everything above: crawlers don't run JS.
  for (const [selector, html] of Object.entries(injections.html || {})) {
    rewriter.on(selector, { element(el) { el.setInnerContent(html, { html: true }); } });
  }
  for (const [selector, text] of Object.entries(injections.text || {})) {
    rewriter.on(selector, { element(el) { el.setInnerContent(text); } });
  }
  for (const selector of injections.remove || []) {
    rewriter.on(selector, { element(el) { el.remove(); } });
  }

  return rewriter.transform(assetResponse);
}

// Shared by both the static-VIEWS path and the dynamic match-detail path
// below — strips index.html's own validators (they describe the source
// file, not this per-request transformed body) and stamps the real
// Content-Type, since HTMLRewriter output otherwise inherits whatever the
// asset response had.
function finalizeHtmlResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(response.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Both redirects below stay on whatever host the request arrived on rather
    // than hardcoding ORIGIN — otherwise `wrangler dev` and the workers.dev
    // preview would bounce every test request to production. Consolidating
    // apex vs www is a DNS/redirect-rule concern, and the canonical tags
    // already carry that signal.

    // Normalize a trailing slash to the bare path (/about/ -> /about) so the
    // two spellings can't both get indexed.
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.replace(/\/+$/, '');
      return Response.redirect(`${url.origin}${pathname}${url.search}`, 301);
    }

    const redirectTo = REDIRECTS.get(pathname);
    if (redirectTo) {
      return Response.redirect(`${url.origin}${redirectTo}${url.search}`, 301);
    }

    if (pathname.startsWith('/api/tasks/')) {
      return handleTasksRequest(request, env, url);
    }

    // Same-origin JSON for the client-side fallback in index.html's <script>.
    // Server-side injection (below) only runs when /find-my-car is the
    // literal requested URL — a cold load or crawler hit. Most real visits
    // reach Find My Car via showPage('find'), a client-side swap onto
    // markup that was baked for whatever OTHER route was actually
    // requested, so its #rm-teaser-grid ships empty. This endpoint is what
    // that swap calls to fill it in. (A direct cross-origin call to
    // dealer-api would work too — CORS is already open there — but routing
    // it through this worker keeps the DEALER_API binding as the one path
    // data flows through, same as the server-rendered case.)
    if (pathname === '/api/recent-matches-teaser') {
      const data = await fetchDealerApiJson(env, '/api/public/recent-matches');
      const featured = (data?.matches || []).filter(m => m.featured).slice(0, 3);
      return new Response(JSON.stringify({ matches: featured }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // Same client-side-SPA-navigation fallback, same reasoning, for the
    // Sell My Car page's "Currently Sourcing Buyers For" block.
    if (pathname === '/api/sourcing-buyers-teaser') {
      const data = await fetchDealerApiJson(env, '/api/public/sourcing-buyers');
      return new Response(JSON.stringify({ vehicles: (data?.vehicles || []).slice(0, 3) }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (pathname === '/sitemap.xml') {
      const issues = await loadIssues(env, url.origin);
      return new Response(sitemapXml(issues), {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          // The URL list is static, so this is purely about not re-running the
          // rewrite for every crawler hit.
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    const isGetOrHead = request.method === 'GET' || request.method === 'HEAD';

    // A single match's own page (e.g. /recent-matches/samantha-cx5). The slug
    // isn't known at deploy time — admin adds these anytime — so unlike every
    // other route it can't live in the static VIEWS list; it's looked up
    // against dealer-api on every request instead.
    const matchDetailSlug = isGetOrHead && pathname.match(/^\/recent-matches\/([a-z0-9-]+)$/)?.[1];
    if (matchDetailSlug) {
      const data = await fetchDealerApiJson(env, `/api/public/recent-matches/${matchDetailSlug}`);
      if (!data?.match) {
        return new Response('Not found', { status: 404 });
      }
      const m = data.match;
      const view = {
        path: pathname,
        page: 'recent-match-detail',
        title: `${m.card_title} — Recent Match | TheExactMatch`,
        description: `${m.card_title}: ${m.vehicle} — $${m.savings_amount.toLocaleString()} saved. See how we found it, negotiated it, and got it done.`,
      };
      const asset = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
      if (!asset.ok) return asset;
      const photoHtml = m.photo_url
        ? `<img src="${escapeHtml(m.photo_url)}" alt="${escapeHtml(m.card_title)}" class="rmd-photo"/>`
        : `<div class="rmd-photo rm-photo-placeholder"><span>Photo coming soon</span></div>`;
      const tagsHtml = m.tags.map(t => `<span class="rm-tag">${escapeHtml(t)}</span>`).join('');
      const savedHtml = `$${m.savings_amount.toLocaleString()} <span class="rm-saved-label">Saved</span>`;
      const response = renderView(asset, view, {
        html: { '#rmd-photo-wrap': photoHtml, '#rmd-tags': tagsHtml, '#rmd-saved': savedHtml },
        text: {
          '#rmd-heading': m.card_title,
          '#rmd-vehicle': m.vehicle,
        },
      });
      return finalizeHtmlResponse(response);
    }

    const view = VIEWS_BY_PATH.get(pathname);
    if (!view || !isGetOrHead) {
      return env.ASSETS.fetch(request);
    }

    // Recent Matches teaser (Find My Car) and listing grid (/recent-matches)
    // are the only other spots needing live data — everything else on these
    // views is static markup already baked into index.html.
    const injections = { html: {}, remove: [] };
    if (view.page === 'find') {
      const data = await fetchDealerApiJson(env, '/api/public/recent-matches');
      const featured = (data?.matches || []).filter(m => m.featured).slice(0, 3);
      if (featured.length) {
        injections.html['#rm-teaser-grid'] = featured.map(m => recentMatchCardHtml(m, '/recent-matches')).join('');
      } else {
        // Nothing published/featured yet — remove the whole section rather
        // than ship an empty heading with no cards under it.
        injections.remove.push('#rm-teaser-section');
      }
    } else if (view.page === 'recent-matches') {
      const data = await fetchDealerApiJson(env, '/api/public/recent-matches');
      const matches = data?.matches || [];
      injections.html['#rm-listing-grid'] = matches.length
        ? matches.map(m => recentMatchCardHtml(m, `/recent-matches/${m.slug}`)).join('')
        : `<p style="grid-column:1/-1;text-align:center;color:var(--gray);font-size:.9rem">More matches are on the way — check back soon.</p>`;
    } else if (view.page === 'sell') {
      // Real submissions admin has published only — never fabricated. Fewer
      // than 3 (or zero) is an expected, legitimate state, not an error:
      // fall back to a generic proof-of-activity line rather than padding
      // with anything made up.
      const data = await fetchDealerApiJson(env, '/api/public/sourcing-buyers');
      const vehicles = (data?.vehicles || []).slice(0, 3);
      injections.html['#sb-grid'] = vehicles.length
        ? vehicles.map(sourcingBuyerCardHtml).join('')
        : `<div class="sb-fallback">Actively sourcing offers for sellers across Texas.</div>`;
    }

    // Pull index.html itself rather than the requested path, which by
    // definition has no file behind it. The incoming request is deliberately
    // NOT forwarded as the init: its conditional headers (If-None-Match etc.)
    // would be matched against index.html's ETag, and a 304 would hand the
    // browser a cached copy of the *unrewritten* page for this URL.
    const asset = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
    if (!asset.ok) return asset;

    const response = renderView(asset, view, injections);
    return finalizeHtmlResponse(response);
  },
};
