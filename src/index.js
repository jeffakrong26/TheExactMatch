// Site worker for theexactmatch.com.
//
// index.html is a single-page app: it holds six `.page` divs and showPage()
// toggles which one is `active`. That reads fine for humans but gives every
// view the same URL, so a crawler only ever sees the default Find My Car view
// — and the AI crawlers we explicitly invite in robots.txt (GPTBot,
// PerplexityBot, ClaudeBot) generally don't run JS at all, so client-side
// routing alone would still serve them the wrong content on every path.
//
// This worker gives each view a real URL and rewrites the HTML per path, so
// the correct page div is already active and the title/description/canonical
// are correct in the *initial* response, with no JS required. index.html stays
// the single source of truth — nothing is duplicated.
//
// Static assets are served before this worker runs (the Wrangler default), so
// only paths with no matching file reach us. `/` therefore never hits the
// worker — index.html's own <head> is already the home/Find My Car metadata,
// which is why the defaults there must stay in sync with VIEWS[0] below.

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
    page: 'find',
    title: 'TheExactMatch — Find Your Car. Sell Your Car. Free.',
    description:
      "Tell us what you want and we'll find it. We search our nationwide dealer network and send you 3 curated options within 24 hours. Free, no obligation.",
  },
  {
    path: '/sell-my-car',
    page: 'sell',
    title: 'Sell My Car — Real Offers, No Dealership Games | TheExactMatch',
    description:
      'Tell us about your vehicle and we send it to our dealer network. Get real offers with no negotiating, no dealership games and no pressure.',
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
    title: 'About Jeff Akrong — A Person Who Knows Cars | TheExactMatch',
    description:
      'Not an algorithm — a person who knows cars. Jeff Akrong spent years at Mercedes-Benz, Audi and Infiniti and knows this market from every angle.',
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
];

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

// /find-my-car is the URL people will guess for the home view; serving the
// same content at both paths would be duplicate content. /weeklyfinds is the
// pre-existing flat URL for Issue No. 1, kept alive as a 301 so shared links
// and any accumulated ranking survive the move to the per-issue path.
const REDIRECTS = new Map([
  ['/find-my-car', '/'],
  ['/weeklyfinds', `${ISSUE_BASE}/issue-1`],
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
    ...VIEWS.map(v => urlEntry(v.path, LASTMOD)),
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

function renderView(assetResponse, view) {
  const canonical = `${ORIGIN}${view.path}`;

  return (
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
      })
      .transform(assetResponse)
  );
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

    const view = VIEWS_BY_PATH.get(pathname);
    if (!view || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return env.ASSETS.fetch(request);
    }

    // Pull index.html itself rather than the requested path, which by
    // definition has no file behind it. The incoming request is deliberately
    // NOT forwarded as the init: its conditional headers (If-None-Match etc.)
    // would be matched against index.html's ETag, and a 304 would hand the
    // browser a cached copy of the *unrewritten* page for this URL.
    const asset = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
    if (!asset.ok) return asset;

    const response = renderView(asset, view);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    // index.html's validators describe the source file, not this transformed
    // body — leaving them on would let two different views share a cache entry.
    headers.delete('ETag');
    headers.delete('Last-Modified');
    return new Response(response.body, { status: 200, headers });
  },
};
