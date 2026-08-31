// Site worker for theexactmatch.com.
//
// Per-URL page migration (2026-08-27): this worker used to serve one shared
// index.html on every route — all pages present as hidden `.page` divs, a
// client showPage() router toggling which one was visible, and this worker
// only rewriting title/meta/canonical/active-class. That meant every URL
// shipped every other page's full content in the response (crawlers that
// don't run JS, which is most of them, saw ~90% duplicate content and 5+ H1s
// per page — the actual reason the domain wasn't ranking for anything).
//
// Now each route is a real, standalone HTML file under pages/ containing
// only that page's own markup (one <h1>, no other page's content anywhere in
// the DOM). Shared chrome (nav, mobile menu, newsletter popup, footer) is
// server-side-included: each page file carries an empty `<div id="...-slot">`
// placeholder, and this worker replaces it with the real markup from the
// constants below on every request — the same pattern FOUNDER_CARD_HTML
// already used for the shared founder-card component. Per-route
// title/meta/canonical/OG/JSON-LD rewriting works exactly as before.
//
// Static assets are served before this worker runs (the Wrangler default), so
// only paths with no matching file reach us.
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
const LASTMOD = '2026-08-27';

// ── Shared server-side includes ──────────────────────────────────────────
// Single source of truth for nav/mobile-menu/newsletter-popup/footer, so an
// item added to one page can't drift out of sync with the rest — the exact
// failure mode the old hand-duplicated-in-14-places footer/nav comments
// warned about. Each is injected into its own `<div id="...-slot"></div>`
// placeholder via HTMLRewriter's `.replace()`, once per request.
//
// New pages awaiting copy approval (see the per-URL migration plan) are
// deliberately absent from this list until then — /car-buying-concierge,
// /car-broker, /dealers, /advice/buying-a-car-out-of-state,
// /advice/how-to-sell-a-financed-car. /sell/ (hub) and /sell/tesla are present
// because the sell-brand pages structurally need the hub to exist, and
// their copy is comparatively low-risk (a plain list of brands already
// live elsewhere on the site) — still flagged for review, just not held
// back from linking.
// Simple stroke-style 24x24 icons, keyed by name, shared by both the
// desktop panel links and the mobile accordion links below — one set, not
// two hand-copied ones.
const NAV_ICONS = {
  search: '<circle cx="10" cy="10" r="6"/><path d="M20 20l-5.2-5.2"/>',
  concierge: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.2"/><path d="M9.8 13.2 18 5m0 0h-3.5M18 5v3.5M14.5 8.5l2 2"/>',
  steps: '<path d="M4 19h4v-4H4v4zM10 19h4v-9h-4v9zM16 19h4V6h-4v13z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  tag: '<path d="M12.6 3.6 20 11l-8.4 8.4a2 2 0 0 1-2.8 0L4 14.6V7a3.4 3.4 0 0 1 3.4-3.4H12.6z"/><circle cx="9" cy="9" r="1.3"/>',
  car: '<path d="M4 16V11l2.2-4.4A2 2 0 0 1 8 5.5h8a2 2 0 0 1 1.8 1.1L20 11v5"/><path d="M4 16h16v2.5a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1V17h-9v1.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V16z"/><circle cx="7.5" cy="16" r="1.4"/><circle cx="16.5" cy="16" r="1.4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  doc: '<path d="M6 3.5h8L19 8.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5V9h5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M4 6.5l8 6.5 8-6.5"/>',
};
const svgIcon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[name] || ''}</svg>`;

// ── Single source of truth for nav links ─────────────────────────────────
// Both renderDesktopNav() (mega menu) and renderMobileMenu() (accordion
// slide-out) read from this same data — adding a page to the nav later
// means editing one entry here, not two separate hand-written markup
// blocks that can quietly drift apart. `page` matches the `page` id already
// used in VIEWS, reused here for active-state highlighting the same way the
// old flat nav did.
const NAV_GROUPS = [
  {
    key: 'find', label: 'Find a Car',
    featured: { page: 'findmycar', href: '/find-my-car', icon: 'search', title: 'Find My Car — Free', desc: '3 real matches in 24 hours' },
    links: [
      { page: 'carbuyingconcierge', href: '/car-buying-concierge', icon: 'concierge', title: 'Car Buying Concierge', desc: 'The full concept, explained.' },
      { page: 'carbroker', href: '/car-broker', icon: 'key', title: 'Car Broker', desc: 'How broker terms map to what we do.' },
      { page: 'howitworks', href: '/how-it-works', icon: 'steps', title: 'How It Works', desc: 'Step by step, start to finish.' },
      { page: 'recentmatches', href: '/recent-matches', icon: 'grid', title: 'Recent Matches', desc: "See what we've found lately." },
    ],
  },
  {
    key: 'sell', label: 'Sell a Car',
    featured: { page: 'sellmycar', href: '/sell-my-car', icon: 'tag', title: 'Sell My Car', desc: 'Multiple real dealer offers, not one instant lowball.' },
    links: [
      { page: 'sell-brand', href: '/sell/ferrari', icon: 'car', title: 'Sell My Ferrari' },
      { page: 'sell-brand', href: '/sell/porsche', icon: 'car', title: 'Sell My Porsche' },
      { page: 'sell-brand', href: '/sell/bentley', icon: 'car', title: 'Sell My Bentley' },
      { page: 'sell-hub', href: '/sell/', icon: 'arrow', title: 'View All Brands →' },
    ],
  },
  {
    key: 'resources', label: 'Resources', simple: true, eyebrow: 'Guides & Advice',
    links: [
      { page: 'advice-negotiate', href: '/advice/how-to-negotiate-car-price', icon: 'doc', title: 'Negotiating Car Price' },
      { page: 'advice-outofstate', href: '/advice/buying-a-car-out-of-state', icon: 'doc', title: 'Buying Out of State' },
      { page: 'advice-financedcar', href: '/advice/how-to-sell-a-financed-car', icon: 'doc', title: 'Selling a Financed Car' },
      { page: 'weeklyfinds', href: '/weekly-finds', icon: 'mail', title: 'Recent Finds' },
    ],
  },
];
const NAV_STANDALONE = [
  { page: 'whiteglove', href: '/white-glove', label: 'White Glove' },
  { page: 'about', href: '/about', label: 'About' },
];
const NAV_PHONE = { href: 'tel:5126509328', label: '(512) 650-9328' };
const NAV_DEALERS = { page: 'dealers', href: '/dealers', label: 'For Dealers' };
const NAV_LOGIN = { href: '/Dealerportal.html', label: 'Login' };

const groupIsActive = (group, activePage) =>
  group.featured?.page === activePage || group.links.some((l) => l.page === activePage);

const panelLinkHtml = (link, feature = false) => `<a class="panel-link${feature ? ' panel-feature' : ''}" href="${link.href}">
          <span class="icon">${svgIcon(link.icon)}</span>
          <div><div class="text-title">${link.title}</div>${link.desc ? `<div class="text-desc">${link.desc}</div>` : ''}</div>
        </a>`;

const mobileLinkHtml = (link) => `<a class="mobile-link" href="${link.href}" onclick="toggleMenu()">
            <span class="icon">${svgIcon(link.icon)}</span>
            <div><div class="m-title">${link.title}</div>${link.desc ? `<div class="m-desc">${link.desc}</div>` : ''}</div>
          </a>`;

function renderDesktopNav(activePage) {
  const groupsHtml = NAV_GROUPS.map((group) => {
    const panelInner = group.simple
      ? `<div class="panel-eyebrow">${group.eyebrow}</div>
        <div class="panel-grid cols-1">
          ${group.links.map((l) => panelLinkHtml(l)).join('\n          ')}
        </div>`
      : `<div class="panel-grid cols-2">
          ${panelLinkHtml(group.featured, true)}
          ${group.links.map((l) => panelLinkHtml(l)).join('\n          ')}
        </div>`;
    return `<div class="nav-item">
        <button class="nav-trigger${groupIsActive(group, activePage) ? ' active' : ''}" data-menu="${group.key}">
          ${group.label}
          <svg class="chevron" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <div class="panel" data-panel="${group.key}">
          ${panelInner}
        </div>
      </div>`;
  }).join('\n      ');
  const standaloneHtml = NAV_STANDALONE.map(
    (link) => `<a class="nav-link${link.page === activePage ? ' active' : ''}" href="${link.href}">${link.label}</a>`
  ).join('\n      ');
  return `<nav id="nav">
  <div class="nav-inner">
    <a class="logo" href="/">The<span>Exact</span>Match</a>
    <div class="nav-center">
      ${groupsHtml}
      ${standaloneHtml}
    </div>
    <div class="nav-right">
      <a class="nav-phone" href="${NAV_PHONE.href}">${NAV_PHONE.label}</a>
      <a class="nav-dealers${NAV_DEALERS.page === activePage ? ' active' : ''}" href="${NAV_DEALERS.href}">${NAV_DEALERS.label}</a>
      <a class="nav-login" href="${NAV_LOGIN.href}">${NAV_LOGIN.label}</a>
      <div class="hamburger" id="hamburger" onclick="toggleMenu()">
        <span></span><span></span><span></span>
      </div>
    </div>
  </div>
</nav>`;
}

function renderMobileMenu() {
  const accordionHtml = NAV_GROUPS.map((group) => {
    const allLinks = group.featured ? [group.featured, ...group.links] : group.links;
    return `<div class="accordion-item">
    <button class="accordion-trigger" data-target="${group.key}">
      ${group.label}
      <svg class="chevron" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg>
    </button>
    <div class="accordion-body" data-body="${group.key}">
      <div class="accordion-links">
        ${allLinks.map((l) => mobileLinkHtml(l)).join('\n        ')}
      </div>
    </div>
  </div>`;
  }).join('\n  ');
  const standaloneHtml = NAV_STANDALONE.map(
    (link) => `<a class="standalone-link" href="${link.href}" onclick="toggleMenu()">${link.label}</a>`
  ).join('\n  ');
  return `<div class="mobile-menu" id="mobile-menu">
  ${accordionHtml}
  ${standaloneHtml}
  <div class="mobile-footer">
    <a class="mobile-phone" href="${NAV_PHONE.href}">${NAV_PHONE.label}</a>
    <div class="mobile-utility-row">
      <a class="mobile-dealers" href="${NAV_DEALERS.href}" onclick="toggleMenu()">${NAV_DEALERS.label}</a>
      <a class="mobile-login" href="${NAV_LOGIN.href}" onclick="toggleMenu()">${NAV_LOGIN.label}</a>
    </div>
  </div>
</div>`;
}

function navHtml(activePage) {
  return renderDesktopNav(activePage);
}

const MOBILE_MENU_HTML = renderMobileMenu();

const FOOTER_SOCIAL_SVG = `<div class="footer-social">
      <a href="https://facebook.com/theexactmatch" target="_blank" rel="noopener noreferrer" aria-label="TheExactMatch on Facebook">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.675 0h-21.35C.595 0 0 .593 0 1.325v21.351C0 23.407.595 24 1.325 24H12.82v-9.294H9.692v-3.622h3.128V8.413c0-3.1 1.893-4.788 4.659-4.788 1.325 0 2.463.099 2.795.143v3.24h-1.918c-1.504 0-1.795.715-1.795 1.763v2.313h3.587l-.467 3.622h-3.12V24h6.115C23.407 24 24 23.407 24 22.676V1.325C24 .593 23.407 0 22.675 0z"/></svg>
      </a>
      <a href="https://instagram.com/theexactmatch" target="_blank" rel="noopener noreferrer" aria-label="TheExactMatch on Instagram">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.332.014 7.052.072 2.695.272.273 2.69.073 7.052.014 8.332 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.332 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>
      </a>
    </div>`;

// The homepage gets one extra strip above this shared footer (a compact
// "sell your car" brand list) — that's built into pages/home.html directly
// rather than parameterized here, since it's a one-page addition, not a
// second footer variant.
const FOOTER_HTML = `<footer>
  <div><div class="footer-logo">The<span>Exact</span>Match</div><div class="footer-sub">Your car, found. — Nationwide</div></div>
  <ul class="footer-nav">
    <li><a href="/find-my-car">Find My Car</a></li>
    <li><a href="/sell-my-car">Sell My Car</a></li>
    <li><a href="/how-it-works">How It Works</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/weekly-finds">Recent Finds</a></li>
    <li><a href="/guides">Guides</a></li>
    <li><a href="/contact">Contact</a></li>
    <li><a href="/privacy-policy">Privacy</a></li>
  </ul>
  <div style="display:flex;align-items:center;gap:1.5rem">
    <div class="footer-copy">© 2026 TheExactMatch.com</div>
    ${FOOTER_SOCIAL_SVG}
  </div>
</footer>`;

const NEWSLETTER_POPUP_HTML = `<div id="nl-overlay" role="dialog" aria-modal="true" aria-labelledby="nl-title-id">
  <div id="nl-card">
    <button id="nl-close" aria-label="Close newsletter popup">&times;</button>
    <div class="nl-rule"></div>
    <div class="nl-eyebrow">Recent Finds</div>
    <div class="nl-title" id="nl-title-id">Jeff's <strong>Recent Finds</strong></div>
    <div class="nl-sub">Get hand-picked vehicle opportunities as we spot them — no fixed schedule, just real finds.</div>
    <div class="nl-cats">
      <span class="nl-cat">Luxury</span>
      <span class="nl-cat">Exotic</span>
      <span class="nl-cat">Under $50k</span>
      <span class="nl-cat">Trucks</span>
    </div>
    <div id="nl-msg"></div>
    <div class="nl-form">
      <input class="nl-input" id="nl-email" type="email" placeholder="your@email.com" autocomplete="email" aria-label="Email address"/>
      <button class="nl-btn" id="nl-submit">Get Recent Finds</button>
    </div>
    <div class="nl-micro">No spam. Just real opportunities worth looking at.</div>
  </div>
</div>`;

// Same reasoning as FOUNDER_CARD_HTML below: one definition, injected into
// every .founder-card-slot on the site (About's hero, and beside the
// Find My Car / Sell My Car forms). Uses images/jeff-headshot-compact.jpg —
// see the comment on FOUNDER_CARD_PHOTO_NOTE in git history for why a
// dedicated pre-crop exists instead of relying on object-position.
const FOUNDER_CARD_HTML = `<div class="founder-card">
  <img class="founder-card-photo" src="/images/jeff-headshot-compact.jpg" alt="Jeff Akrong"/>
  <div class="founder-card-body">
    <div class="founder-card-name">Jeff Akrong</div>
    <div class="founder-card-line">Dealership insider turned buyer's advocate — ex-Audi, Mercedes-Benz, Aston Martin, Rolls-Royce &amp; Bentley. Now entirely on your side, free.</div>
    <a class="founder-card-link" href="/about">Meet Jeff &rarr;</a>
  </div>
</div>`;

// Sitewide structured data — Organization (unchanged from before) plus the
// new AutomotiveBusiness/LocalBusiness entry. No `address`: no real street
// address exists anywhere in this business's records to put here, and
// schema.org doesn't require one for AutomotiveBusiness to validate —
// areaServed + telephone stand in rather than a fabricated address, same
// reasoning already used for the city-page LocalBusiness entries below.
const SITEWIDE_SCHEMA = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      name: 'The Exact Match',
      url: ORIGIN,
      sameAs: ['https://facebook.com/theexactmatch', 'https://instagram.com/theexactmatch'],
    },
    {
      '@type': 'AutomotiveBusiness',
      name: 'The Exact Match',
      url: ORIGIN,
      telephone: '+1-512-650-9328',
      areaServed: [
        { '@type': 'Country', name: 'United States' },
        { '@type': 'City', name: 'Austin', containedInPlace: { '@type': 'State', name: 'Texas' } },
        { '@type': 'City', name: 'Houston', containedInPlace: { '@type': 'State', name: 'Texas' } },
        { '@type': 'City', name: 'Dallas', containedInPlace: { '@type': 'State', name: 'Texas' } },
        { '@type': 'City', name: 'San Antonio', containedInPlace: { '@type': 'State', name: 'Texas' } },
        { '@type': 'City', name: 'El Paso', containedInPlace: { '@type': 'State', name: 'Texas' } },
      ],
    },
  ],
};

// The single place a public route is defined. Both the HTML rewriting and
// sitemap.xml are generated from this list. `file` is the real per-URL
// document under pages/ that this route serves — replaces the old
// "every route rewrites the same index.html" model. `noindex: true` marks a
// page that's live and reachable but deliberately excluded from the sitemap
// and from robots indexing — used only for pages awaiting copy review (see
// the per-URL migration plan); remove the flag once approved.
const VIEWS = [
  {
    path: '/',
    page: 'home',
    file: '/pages/home.html',
    lastmod: '2026-08-31',
    title: "TheExactMatch — We Don't List Cars. We Find Yours.",
    description:
      "Tell us what you want — we search our dealer network, negotiate the price, and deliver your exact match. Free, no obligation.",
  },
  {
    path: '/find-my-car',
    page: 'findmycar',
    file: '/pages/find-my-car.html',
    lastmod: '2026-08-27',
    title: 'Find My Car — Search, Negotiate & Deliver | TheExactMatch',
    description:
      "Tell us what you want and we'll find it. We search our nationwide dealer network and send you 3 curated options within 24 hours. Free, no obligation.",
  },
  {
    path: '/sell-my-car',
    page: 'sellmycar',
    file: '/pages/sell-my-car.html',
    lastmod: '2026-08-31',
    title: 'Sell My Car — Multiple Real Offers, Not One Lowball | TheExactMatch',
    description:
      "Skip the single instant-offer lowball. We send your car to multiple dealers actively buying your segment and bring back real, competing offers within 24 hours — you choose, or walk away.",
  },
  {
    path: '/recent-matches',
    page: 'recentmatches',
    file: '/pages/recent-matches.html',
    lastmod: '2026-08-27',
    title: 'Recent Matches — Real Deals We\'ve Closed | TheExactMatch',
    description:
      'Real cars we\'ve found, negotiated, and closed for clients — savings, warranties, and what actually happened on each deal.',
  },
  {
    path: '/how-it-works',
    page: 'howitworks',
    file: '/pages/how-it-works.html',
    lastmod: '2026-08-27',
    title: 'How It Works — Find My Car & Sell My Car | TheExactMatch',
    description:
      "Two services, one goal — making your car transaction effortless. Here's exactly how Find My Car and Sell My Car work, step by step.",
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: "What's actually free, and what isn't?",
          acceptedAnswer: {
            '@type': 'Answer',
            text: "Search and matching are free, always — the form, the search, and your 3 curated options cost nothing, whether you're buying or selling. White Glove — Jeff personally negotiating, handling paperwork, and coordinating the closing — is a separate, optional paid tier: a flat fee starting at $249 for standard vehicles, or a custom quote (capped at $7,000) for hard-to-find ones.",
          },
        },
        {
          '@type': 'Question',
          name: 'Do I have to use White Glove?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: "No. Once you have your 3 matched options (or your offers, if you're selling), you're free to contact the dealer directly and handle negotiation and closing yourself at no cost. White Glove is there if you'd rather Jeff handle that part — it's never required.",
          },
        },
        {
          '@type': 'Question',
          name: "What if none of my 3 options are right?",
          acceptedAnswer: {
            '@type': 'Answer',
            text: "Tell us what missed and why — too far off budget, wrong trim, wrong condition — and we go back to the network with that in mind. There's no charge to keep searching, and no limit on how many rounds it takes to get it right.",
          },
        },
        {
          '@type': 'Question',
          name: 'Is Find My Car priced differently than Sell My Car?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No — both work the same way. Search and matching are free on both sides; White Glove is available on both if you want the full deal handled, priced the same way either way — flat fee or custom quote depending on the vehicle.',
          },
        },
      ],
    },
  },
  {
    path: '/white-glove',
    page: 'whiteglove',
    file: '/pages/white-glove.html',
    lastmod: '2026-08-31',
    title: 'White Glove — We Handle the Whole Deal | TheExactMatch',
    description:
      "Search and matching are free, always. White Glove is the paid, optional tier where we negotiate, coordinate inspections, and arrange transport on your behalf — flat fee for standard vehicles, custom quote (capped at $7,000) for hard-to-find ones.",
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Service',
          serviceType: 'Vehicle purchase negotiation and concierge service',
          provider: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          areaServed: { '@type': 'Country', name: 'United States' },
          offers: [
            {
              '@type': 'Offer',
              name: 'White Glove — Standard vehicles',
              priceSpecification: {
                '@type': 'PriceSpecification',
                price: '249',
                priceCurrency: 'USD',
                description: 'Starting flat fee, confirmed after inquiry based on the specifics of the deal.',
              },
            },
            {
              '@type': 'Offer',
              name: 'White Glove — Hard-to-find vehicles',
              priceSpecification: {
                '@type': 'PriceSpecification',
                maxPrice: '7000',
                priceCurrency: 'USD',
                description: '1% to 5% of the final negotiated price, capped at $7,000, quoted after review.',
              },
            },
          ],
        },
        {
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: 'Is White Glove required?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'No. Every client gets free search and matching regardless. White Glove is only for people who want the entire deal — negotiation through delivery — handled for them.',
              },
            },
            {
              '@type': 'Question',
              name: 'How is the fee determined for hard-to-find vehicles?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: "It depends on how much sourcing and negotiation the vehicle requires. You'll get your exact quote after telling us what you're looking for — never a surprise fee after the fact.",
              },
            },
          ],
        },
      ],
    },
  },
  {
    path: '/about',
    page: 'about',
    file: '/pages/about.html',
    lastmod: '2026-08-27',
    title: "About Jeff Akrong — Dealership Insider Turned Buyer's Advocate | TheExactMatch",
    description:
      "Jeff Akrong spent years selling for Audi, Mercedes-Benz, Aston Martin, Rolls-Royce and Bentley. Now he runs The Exact Match — the same insider playbook, entirely on the buyer's side, for free.",
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: 'Jeff Akrong',
      alternateName: 'Jeff',
      jobTitle: 'Founder',
      url: `${ORIGIN}/about`,
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
    page: 'weeklyfinds',
    file: '/pages/weekly-finds.html',
    lastmod: '2026-08-27',
    title: "Jeff's Recent Finds — Free Car Newsletter | TheExactMatch",
    description:
      'Hand-picked vehicles delivered to your inbox as we find them — luxury, exotic, trucks and hidden gems under $50K. No fluff, just real opportunities.',
  },
  {
    path: '/contact',
    page: 'contact',
    file: '/pages/contact.html',
    lastmod: '2026-08-27',
    title: 'Contact — Talk Cars With Us | TheExactMatch',
    description:
      'Have a question, want to know more about White Glove service, or just want to talk through your situation? Reach out — we respond fast.',
  },
  {
    path: '/privacy-policy',
    page: 'privacy',
    file: '/pages/privacy-policy.html',
    lastmod: '2026-08-31',
    title: 'Privacy Policy | TheExactMatch',
    description:
      'What The Exact Match collects when you use Find My Car, Sell My Car, or White Glove — and how it\'s shared with our dealer network to find your match. We never sell your data.',
  },
  {
    path: '/guides',
    page: 'guides',
    file: '/pages/guides.html',
    lastmod: '2026-08-23',
    title: 'Car Buying Guides | The Exact Match',
    description:
      "In-depth model guides — trims, pricing trends, and what actually matters when you're shopping for a specific car.",
  },
  {
    path: '/guides/audi-r8',
    page: 'guide-audir8',
    file: '/pages/guides/audi-r8.html',
    lastmod: '2026-08-23',
    title: 'Audi R8 Buying Guide: All Trims & Pricing Trends | The Exact Match',
    description:
      'Every Audi R8 trim explained — V8, V10, Performante, manual vs S-tronic — with real market positioning and what to look for.',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Article',
          headline: 'Audi R8 Buying Guide: All Trims & Pricing Trends',
          author: { '@type': 'Person', name: 'Jeff Akrong', url: `${ORIGIN}/about` },
          publisher: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          datePublished: '2026-08-23',
          dateModified: '2026-08-23',
          mainEntityOfPage: `${ORIGIN}/guides/audi-r8`,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Guides', item: `${ORIGIN}/guides` },
            { '@type': 'ListItem', position: 2, name: 'Audi R8 Buying Guide', item: `${ORIGIN}/guides/audi-r8` },
          ],
        },
        {
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
              name: "V8 vs. V10 — what's the real difference?",
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
      ],
    },
  },
];

// ── Advice section (renamed + moved from bare top-level paths) ──────────
const ADVICE_LASTMOD = '2026-08-27';
VIEWS.push({
  path: '/advice/how-to-negotiate-car-price',
  page: 'advice-negotiate',
  file: '/pages/advice/how-to-negotiate-car-price.html',
  lastmod: ADVICE_LASTMOD,
  title: 'How to Negotiate a Car Price: The Complete Guide | The Exact Match',
  description:
    'Real negotiation tactics from a car buying concierge — what actually works at the dealership, what to say, and the mistakes that cost you thousands.',
  jsonLd: {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: 'How to Negotiate a Car Price: The Complete Guide',
        author: { '@type': 'Person', name: 'Jeff Akrong', url: `${ORIGIN}/about` },
        publisher: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
        datePublished: '2026-07-31',
        dateModified: ADVICE_LASTMOD,
        mainEntityOfPage: `${ORIGIN}/advice/how-to-negotiate-car-price`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Advice', item: `${ORIGIN}/advice` },
          { '@type': 'ListItem', position: 2, name: 'How to Negotiate a Car Price', item: `${ORIGIN}/advice/how-to-negotiate-car-price` },
        ],
      },
      {
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
    ],
  },
});

// ── City landing pages ────────────────────────────────────────────────
// All five share the single pages/city.html template. Only the name
// changes, so they're generated from this list rather than written out five
// times. `possessive` is explicit rather than derived: "Dallas's" vs
// "Dallas'" is a style call, not something to leave to string concatenation.
const CITY_LASTMOD = '2026-08-31';
const CITIES = [
  { slug: 'austin',      name: 'Austin',      possessive: "Austin's" },
  { slug: 'houston',     name: 'Houston',     possessive: "Houston's" },
  { slug: 'san-antonio', name: 'San Antonio', possessive: "San Antonio's" },
  { slug: 'dallas',      name: 'Dallas',      possessive: "Dallas's" },
  { slug: 'el-paso',     name: 'El Paso',     possessive: "El Paso's" },
];

// Worded identically to the on-page FAQ. Structured data that disagrees with
// visible content is a manual-action risk, not a boost — if the copy in
// pages/city.html changes, this must change with it.
const CITY_FAQ = [
  [
    'How much does it cost?',
    "Nothing. There's no fee, no subscription, and no charge for the search — finding your car is free. If you want the whole deal handled, that's White Glove, our optional paid service.",
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
    file: '/pages/city.html',
    city,
    lastmod: CITY_LASTMOD,
    title: `Buy a Car in ${city.name}, TX — Nationwide Reach | The Exact Match`,
    description: `Based in ${city.name}, serving all 50 states. Tell us what you want and we find it, negotiate it, and handle the paperwork — with especially deep reach right here in Texas.`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'FAQPage',
          mainEntity: CITY_FAQ.map(([name, text]) => ({
            '@type': 'Question',
            name,
            acceptedAnswer: { '@type': 'Answer', text },
          })),
        },
        {
          '@type': 'LocalBusiness',
          name: `The Exact Match — ${city.name}, TX`,
          url: `${ORIGIN}/${city.slug}`,
          telephone: '+1-512-650-9328',
          areaServed: {
            '@type': 'City',
            name: city.name,
            containedInPlace: { '@type': 'State', name: 'Texas' },
          },
          parentOrganization: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
        },
      ],
    },
  });
}

// ── Brand-specific sell pages ───────────────────────────────────────────
// All nine share the single pages/sell/brand.html template. Routed under
// /sell/[brand] now that dealer-api's Cloudflare route has been narrowed to
// just its four private token subpaths (see dealer-api/wrangler.jsonc) —
// this used to have to live at /sell-my-car/[brand] because /sell/* was
// entirely claimed. 301s from the old path are in REDIRECTS below.
//
// Tesla added per this migration; the other eight (exotic/ultra-luxury,
// same reasoning as before: the general Sell My Car flow already handles
// mainstream-luxury brands well) carry over unchanged.
const SELL_BRAND_LASTMOD = '2026-08-27';
const SELL_BRANDS = [
  { slug: 'ferrari',      name: 'Ferrari' },
  { slug: 'bentley',      name: 'Bentley' },
  { slug: 'porsche',      name: 'Porsche' },
  { slug: 'lamborghini',  name: 'Lamborghini' },
  { slug: 'mclaren',      name: 'McLaren' },
  { slug: 'rolls-royce',  name: 'Rolls-Royce' },
  { slug: 'tesla',        name: 'Tesla' },
  { slug: 'aston-martin', name: 'Aston Martin' },
  { slug: 'maserati',     name: 'Maserati' },
];

for (const brand of SELL_BRANDS) {
  VIEWS.push({
    path: `/sell/${brand.slug}`,
    page: 'sell-brand',
    file: '/pages/sell/brand.html',
    brand,
    lastmod: SELL_BRAND_LASTMOD,
    title: `Sell Your ${brand.name} — Real Offers, Not One Lowball | TheExactMatch`,
    description: `Selling a ${brand.name}? We send it to dealers and specialist buyers actively looking for exactly this, and bring back real, competing offers within 24 hours. Free, no obligation.`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Service',
          serviceType: `Sell a ${brand.name}`,
          provider: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          areaServed: { '@type': 'Country', name: 'United States' },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Sell', item: `${ORIGIN}/sell/` },
            { '@type': 'ListItem', position: 2, name: `Sell Your ${brand.name}`, item: `${ORIGIN}/sell/${brand.slug}` },
          ],
        },
        {
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: `How much does it cost to sell my ${brand.name} through The Exact Match?`,
              acceptedAnswer: {
                '@type': 'Answer',
                text: "Nothing to submit your car and get offers — that part is always free. If you'd rather Jeff handle negotiation, inspection, and paperwork for you, that's the separate, optional White Glove tier.",
              },
            },
            {
              '@type': 'Question',
              name: `Who actually buys the ${brand.name}?`,
              acceptedAnswer: {
                '@type': 'Answer',
                text: `Dealers and specialist buyers in our network who are actively looking for a ${brand.name} like yours — not one instant-offer lowballer. You get multiple real, competing offers back within 24 hours and choose, or walk away.`,
              },
            },
          ],
        },
      ],
    },
  });
}

// ── Pages added by the per-URL migration ──────────────────────────────────
// Shipped with real, drafted copy — grounded only in facts already
// established for this business, no invented stats/testimonials/claims —
// held `noindex` and out of the sitemap pending review; approved and
// unflagged 2026-08-28.
const NEW_LASTMOD = '2026-08-27';
VIEWS.push(
  {
    path: '/car-buying-concierge',
    page: 'carbuyingconcierge',
    file: '/pages/car-buying-concierge.html',
    lastmod: NEW_LASTMOD,
    title: 'Car Buying Concierge — Nationwide, Free Search & Negotiation | The Exact Match',
    description:
      "A car buying concierge who works for you, not the dealer: free search across our nationwide dealer network, real negotiation, and delivery — with the option to have the whole deal handled for you.",
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Service',
          serviceType: 'Car buying concierge',
          provider: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          areaServed: { '@type': 'Country', name: 'United States' },
        },
        {
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What does a car buying concierge actually do?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: "Searches our dealer network for exactly what you asked for, sends you 3 real matched options within 24 hours, and — if you want it — negotiates the price and coordinates the closing on your behalf. The search and matching are free; full-service negotiation is the optional White Glove tier.",
              },
            },
            {
              '@type': 'Question',
              name: 'Is this only for Texas?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: "No — the dealer network is nationwide. Texas is where the business is based and where reach runs deepest, but the same search and matching process works for buyers anywhere in the US.",
              },
            },
          ],
        },
      ],
    },
  },
  {
    path: '/car-broker',
    page: 'carbroker',
    file: '/pages/car-broker.html',
    lastmod: NEW_LASTMOD,
    title: 'Car Broker — We Search, Negotiate & Deliver | The Exact Match',
    description:
      "An auto broker who works for the buyer, not the lot: free nationwide search, real negotiation against dealer inventory, and the option to have the entire purchase handled for you.",
  },
  {
    path: '/dealers',
    page: 'dealers',
    file: '/pages/dealers.html',
    lastmod: NEW_LASTMOD,
    title: 'For Dealers — Partner With The Exact Match | TheExactMatch',
    description:
      "We send pre-qualified, ready-to-transact buyers and sellers straight to your lot. No listing fees — we're paid a commission only when a deal actually closes.",
  },
  {
    path: '/advice/buying-a-car-out-of-state',
    page: 'advice-outofstate',
    file: '/pages/advice/buying-a-car-out-of-state.html',
    lastmod: NEW_LASTMOD,
    title: 'Buying a Car Out of State: What to Know | The Exact Match',
    description:
      'What actually changes when you buy from an out-of-state dealer — titling, sales tax, inspection, and shipping — explained plainly.',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Article',
          headline: 'Buying a Car Out of State: What to Know',
          author: { '@type': 'Person', name: 'Jeff Akrong', url: `${ORIGIN}/about` },
          publisher: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          datePublished: NEW_LASTMOD,
          dateModified: NEW_LASTMOD,
          mainEntityOfPage: `${ORIGIN}/advice/buying-a-car-out-of-state`,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Advice', item: `${ORIGIN}/advice` },
            { '@type': 'ListItem', position: 2, name: 'Buying a Car Out of State', item: `${ORIGIN}/advice/buying-a-car-out-of-state` },
          ],
        },
      ],
    },
  },
  {
    path: '/advice/how-to-sell-a-financed-car',
    page: 'advice-financedcar',
    file: '/pages/advice/how-to-sell-a-financed-car.html',
    lastmod: NEW_LASTMOD,
    title: 'How to Sell a Car You Still Owe Money On | The Exact Match',
    description:
      'Selling a financed car is normal, not a dead end — how the payoff, the lienholder, and your equity (or shortfall) actually work.',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Article',
          headline: 'How to Sell a Car You Still Owe Money On',
          author: { '@type': 'Person', name: 'Jeff Akrong', url: `${ORIGIN}/about` },
          publisher: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          datePublished: NEW_LASTMOD,
          dateModified: NEW_LASTMOD,
          mainEntityOfPage: `${ORIGIN}/advice/how-to-sell-a-financed-car`,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Advice', item: `${ORIGIN}/advice` },
            { '@type': 'ListItem', position: 2, name: 'How to Sell a Financed Car', item: `${ORIGIN}/advice/how-to-sell-a-financed-car` },
          ],
        },
      ],
    },
  },
  {
    path: '/sell/',
    page: 'sell-hub',
    file: '/pages/sell/index.html',
    lastmod: NEW_LASTMOD,
    title: 'Sell Your Car — Real Offers From Dealers Who Want It | The Exact Match',
    description:
      'Sell your car — including hard-to-find exotics and luxury brands — to dealers actively buying your segment. Free, real, competing offers within 24 hours.',
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Service',
          serviceType: 'Sell a car',
          provider: { '@type': 'Organization', name: 'The Exact Match', url: ORIGIN },
          areaServed: { '@type': 'Country', name: 'United States' },
        },
        {
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: 'What kinds of cars do you help sell?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: 'Any car, through the general Sell My Car form — plus dedicated pages for exotic and ultra-luxury brands where a specialist buyer network makes a real difference: Ferrari, Bentley, Porsche, Lamborghini, McLaren, Rolls-Royce, Tesla, Aston Martin, and Maserati.',
              },
            },
            {
              '@type': 'Question',
              name: 'How is this different from an instant-offer site?',
              acceptedAnswer: {
                '@type': 'Answer',
                text: "An instant-offer site gives you one algorithm-generated lowball number. We send your car to multiple dealers actively buying your segment and bring back real, competing offers within 24 hours — you choose, or walk away.",
              },
            },
          ],
        },
      ],
    },
  },
);

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

// Recent Finds newsletter archive. Each issue is a standalone HTML file at
// /weekly-finds/<slug>, listed in weekly-finds/issues.json.
//
// To publish Issue No. N:
//   1. Add weekly-finds/issue-N.html
//   2. Set its <link rel="canonical"> to
//      https://theexactmatch.com/weekly-finds/issue-N   (apex, no www)
//   3. Append {"slug":"issue-N","title":…,"lastmod":"YYYY-MM-DD"} to
//      weekly-finds/issues.json
//   4. Deploy — the sitemap picks it up with no code change
const ISSUES_MANIFEST = '/weekly-finds/issues.json';
const ISSUE_BASE = '/weekly-finds';
const ISSUE_FILE_BASE = '/weekly-finds'; // where the actual issue files live on disk

// 301s to the current hyphenated URLs. Two distinct generations of old path
// land here: the site's original hyphenated URLs (pre-dating this whole
// per-URL migration), and the brief no-hyphen URLs this same migration
// shipped for about a day before hyphens were restored — both need to keep
// working, since either could already be indexed or linked externally.
// Redirects are checked before VIEWS_BY_PATH, so an old path never falls
// through to a stale asset.
const REDIRECTS = new Map([
  // Brief no-hyphen URLs -> restored hyphenated URLs.
  ['/findmycar', '/find-my-car'],
  ['/sellmycar', '/sell-my-car'],
  ['/howitworks', '/how-it-works'],
  ['/whiteglove', '/white-glove'],
  ['/weeklyfinds', '/weekly-finds'],
  ['/weekly-finds/issue1', '/weekly-finds/issue-1'],
  ['/recentmatches', '/recent-matches'],
  ['/guides/audir8', '/guides/audi-r8'],
  ['/advice/howtonegotiatecarprice', '/advice/how-to-negotiate-car-price'],
  ['/sanantonio', '/san-antonio'],
  ['/elpaso', '/el-paso'],
  ['/sell/rollsroyce', '/sell/rolls-royce'],
  ['/sell/astonmartin', '/sell/aston-martin'],
  ['/carbuyingconcierge', '/car-buying-concierge'],
  ['/carbroker', '/car-broker'],
  ['/advice/buyingacaroutofstate', '/advice/buying-a-car-out-of-state'],
  ['/advice/howtosellafinancedcar', '/advice/how-to-sell-a-financed-car'],
  // Original, pre-migration bare paths -> today's real (still hyphenated)
  // paths, where the route also moved (gained a nesting prefix, etc.).
  ['/how-to-negotiate-car-price', '/advice/how-to-negotiate-car-price'],
  ['/public/contact-message', '/contact'],
]);
// The brand-page redirects below are generated from the same SELL_BRANDS
// list the routes themselves come from, so a renamed slug can't silently
// forget its old-URL redirect. Every brand had a real /sell-my-car/[brand]
// URL at some point (including the ones that only had it briefly under
// their no-hyphen slug — those are covered by the manual entries above).
for (const brand of SELL_BRANDS) {
  if (brand.slug === 'tesla') continue; // no old URL — this one's new
  REDIRECTS.set(`/sell-my-car/${brand.slug}`, `/sell/${brand.slug}`);
}
// The two multi-word brands also need their /sell-my-car/<brand> variant
// caught by its bare (unhyphenated-at-the-time) spelling, same as it always
// was pre-migration.
REDIRECTS.set('/sell-my-car/rollsroyce', '/sell/rolls-royce');
REDIRECTS.set('/sell-my-car/astonmartin', '/sell/aston-martin');

// Recent Matches detail pages and Recent Finds issues both carry a dynamic
// slug that can't live in a static REDIRECTS entry — this catches the brief
// no-hyphen prefixes generally, for any current or future slug.
const PREFIX_REDIRECTS = [
  ['/recentmatches/', '/recent-matches/'],
  ['/weeklyfinds/', '/weekly-finds/'],
];

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
    // A view may pin its own lastmod. noindex views (awaiting copy review)
    // are excluded entirely — they're live and reachable but not yet meant
    // to be discovered/indexed.
    ...VIEWS.filter(v => !v.noindex).map(v => urlEntry(v.path, v.lastmod || LASTMOD)),
    ...STATIC_PAGES.map(p => urlEntry(p.path, LASTMOD)),
    ...issues.map(i => urlEntry(`${ISSUE_BASE}/${i.slug}`, i.lastmod || LASTMOD)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
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
      // Pages awaiting copy review are reachable but not meant to be
      // indexed — see the `noindex` flag on their VIEWS entry.
      .on('head', {
        element(el) {
          if (view.noindex) {
            el.append(`<meta name="robots" content="noindex,nofollow"/>`, { html: true });
          }
          const sitewideJson = JSON.stringify(SITEWIDE_SCHEMA).replace(/<\//g, '<\\/');
          el.append(`<script type="application/ld+json">${sitewideJson}</script>`, { html: true });
          if (view.jsonLd) {
            const json = JSON.stringify(view.jsonLd).replace(/<\//g, '<\\/');
            el.append(`<script type="application/ld+json">${json}</script>`, { html: true });
          }
        },
      })
      // Shared chrome — see the constants above for why these are
      // single-source-of-truth instead of hand-duplicated per page.
      .on('#nl-slot', { element(el) { el.replace(NEWSLETTER_POPUP_HTML, { html: true }); } })
      .on('#nav-slot', { element(el) { el.replace(navHtml(view.page), { html: true }); } })
      .on('#mobile-menu-slot', { element(el) { el.replace(MOBILE_MENU_HTML, { html: true }); } })
      .on('#footer-slot', { element(el) { el.replace(FOOTER_HTML, { html: true }); } })
      .on('.founder-card-slot', { element(el) { el.setInnerContent(FOUNDER_CARD_HTML, { html: true }); } })
      // City substitution for the shared pages/city.html template. Done on
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
      .on('.city-crosslinks li', {
        element(el) {
          if (view.city && el.getAttribute('data-city') === view.city.slug) el.remove();
        },
      })
      // Same substitution pattern for the shared pages/sell/brand.html template.
      .on('.brand-name', {
        element(el) {
          if (view.brand) el.setInnerContent(view.brand.name);
        },
      })
      .on('#brand-cta', {
        element(el) {
          if (view.brand) el.setAttribute('href', `/sell-my-car?make=${encodeURIComponent(view.brand.name)}`);
        },
      })
      .on('.brand-crosslinks li', {
        element(el) {
          if (view.brand && el.getAttribute('data-brand') === view.brand.slug) el.remove();
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

// Strips the source file's own validators (they describe the file on disk,
// not this per-request transformed body) and stamps the real Content-Type,
// since HTMLRewriter output otherwise inherits whatever the asset response
// had.
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

    // Stays on whatever host the request arrived on rather than hardcoding
    // ORIGIN — otherwise `wrangler dev` and the workers.dev preview would
    // bounce every test request to production. Consolidating apex vs www is
    // a DNS/redirect-rule concern, and the canonical tags already carry
    // that signal.

    // Normalize a trailing slash to the bare path (/about/ -> /about) so the
    // two spellings can't both get indexed. /sell/ itself is the one
    // deliberate exception — it's a real hub page whose canonical path has
    // a trailing slash (mirrors how /sell/[brand] reads under it).
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname !== '/sell/' && pathname.endsWith('/')) {
      pathname = pathname.replace(/\/+$/, '');
      return Response.redirect(`${url.origin}${pathname}${url.search}`, 301);
    }

    const redirectTo = REDIRECTS.get(pathname);
    if (redirectTo) {
      return Response.redirect(`${url.origin}${redirectTo}${url.search}`, 301);
    }
    for (const [oldPrefix, newPrefix] of PREFIX_REDIRECTS) {
      if (pathname.startsWith(oldPrefix)) {
        return Response.redirect(`${url.origin}${newPrefix}${pathname.slice(oldPrefix.length)}${url.search}`, 301);
      }
    }

    if (pathname.startsWith('/api/tasks/')) {
      return handleTasksRequest(request, env, url);
    }

    if (pathname === '/sitemap.xml') {
      const issues = await loadIssues(env, url.origin);
      return new Response(sitemapXml(issues), {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    const isGetOrHead = request.method === 'GET' || request.method === 'HEAD';

    // Recent Finds issue archive — /weekly-finds/<slug> serves the standalone
    // file that actually lives at weekly-finds/<slug>.html on disk (the
    // directory name wasn't part of the URL-format rename, only the route).
    const issueSlug = isGetOrHead && pathname.match(/^\/weekly-finds\/([a-z0-9-]+)$/)?.[1];
    if (issueSlug) {
      return env.ASSETS.fetch(new Request(`${url.origin}${ISSUE_FILE_BASE}/${issueSlug}.html`));
    }

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
        page: 'recentmatchdetail',
        title: `${m.card_title} — Recent Match | TheExactMatch`,
        description: `${m.card_title}: ${m.vehicle} — $${m.savings_amount.toLocaleString()} saved. See how we found it, negotiated it, and got it done.`,
      };
      const asset = await env.ASSETS.fetch(new Request(`${url.origin}/pages/recentmatchdetail.html`));
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
    // views is static markup already baked into its page file.
    const injections = { html: {}, remove: [] };
    if (view.page === 'findmycar') {
      const data = await fetchDealerApiJson(env, '/api/public/recent-matches');
      const featured = (data?.matches || []).filter(m => m.featured).slice(0, 3);
      if (featured.length) {
        injections.html['#rm-teaser-grid'] = featured.map(m => recentMatchCardHtml(m, '/recent-matches')).join('');
      } else {
        // Nothing published/featured yet — remove the whole section rather
        // than ship an empty heading with no cards under it.
        injections.remove.push('#rm-teaser-section');
      }
    } else if (view.page === 'recentmatches') {
      const data = await fetchDealerApiJson(env, '/api/public/recent-matches');
      const matches = data?.matches || [];
      injections.html['#rm-listing-grid'] = matches.length
        ? matches.map(m => recentMatchCardHtml(m, `/recent-matches/${m.slug}`)).join('')
        : `<p style="grid-column:1/-1;text-align:center;color:var(--gray);font-size:.9rem">More matches are on the way — check back soon.</p>`;
    } else if (view.page === 'sellmycar') {
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

    // The requested path by definition has no file behind it (that's why we
    // reached the worker) — pull the view's real per-URL file instead. The
    // incoming request is deliberately NOT forwarded as the init: its
    // conditional headers (If-None-Match etc.) would be matched against that
    // file's own ETag, and a 304 would hand the browser a cached copy of the
    // *unrewritten* page for this URL.
    const asset = await env.ASSETS.fetch(new Request(`${url.origin}${view.file}`));
    if (!asset.ok) return asset;

    const response = renderView(asset, view, injections);
    return finalizeHtmlResponse(response);
  },
};
