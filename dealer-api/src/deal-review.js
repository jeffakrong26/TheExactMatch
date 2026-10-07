// Free Deal Review (/review-my-deal) — the deterministic half of the report.
//
// Everything in this file is plain arithmetic or static reference data: the
// verdict thresholds, the fee X-ray, the doc-fee table and the payment math.
// None of it needs (or should get) an LLM — "is $899 over the Texas doc-fee
// guideline" and "does 7.9% over 72 months on $41,000 come to $717/mo" have
// exactly one right answer. The only AI-written parts of a draft are the
// buyer's-order photo extraction and the top-3 push-back items (src/index.js,
// "Deal Reviews" section), and a team member reviews every draft before it
// sends.
//
// Pure functions only (no env, no fetch), so this can be exercised in plain
// Node: `node dealer-api/scripts/deal-review-selftest.mjs`.

// ── Verdict thresholds ──────────────────────────────────────────────────
// Selling price vs. market comparison, as a % difference from market:
//   <= -5%          good deal
//   -5% .. +3%      negotiable
//   >= +3%          walk away
export const VERDICT = {
  good: { key: 'good', label: 'Good deal' },
  negotiable: { key: 'negotiable', label: 'Negotiable' },
  walk: { key: 'walk', label: 'Walk away' },
};
const GOOD_BELOW_PCT = -5;
const WALK_ABOVE_PCT = 3;

export function marketVerdict(sellingPrice, marketValue) {
  if (!(sellingPrice > 0) || !(marketValue > 0)) return null;
  const pct = ((sellingPrice - marketValue) / marketValue) * 100;
  let v = VERDICT.negotiable;
  if (pct <= GOOD_BELOW_PCT) v = VERDICT.good;
  else if (pct >= WALK_ABOVE_PCT) v = VERDICT.walk;
  return { ...v, pct, basis: 'market' };
}

// ── Doc fee reference table ─────────────────────────────────────────────
// Static on purpose: update once a year. AS_OF is shown in every draft so a
// stale table is visible rather than silently trusted.
//
// Sourced 2026-10 from state-by-state compilations (CarEdge "State of Dealer
// Fees 2026", gettruelane.com, quotedefender.com doc-fee map 2026) and, for
// Texas, the OCCC directly (presumed-reasonable amount raised to $225
// effective 2024-07-11; a dealer can charge more only after filing a cost
// analysis with the OCCC). Several caps are CPI-indexed and move every year
// (IL, OH, MO, MI), and the secondary sources disagree on a few (MD, IL) —
// those rows are marked `verify: true` and the draft says so. Before relying
// on this table for anything beyond a draft flag, check each capped state
// against its statute.
//
// `cap`: the legal maximum (or presumed-reasonable amount, for TX).
// `pctCap`: some states cap at "the lesser of $X or N% of price".
// States not listed have no statutory cap; UNCAPPED_HIGH is the point where
// we flag a doc fee as high regardless of state.
export const DOC_FEE_TABLE_AS_OF = '2026-10';
export const UNCAPPED_HIGH = 500;
export const DOC_FEE_TABLE = {
  AR: { cap: 129 },
  CA: { cap: 85, note: '$85 for dealers that register electronically; $70 otherwise.' },
  IA: { cap: 180 },
  IL: { cap: 378, verify: true, note: 'CPI-indexed every year.' },
  LA: { cap: 436, verify: true },
  MD: { cap: 800, verify: true, note: 'Raised by SB 362 (effective July 2024); sources disagree on the current figure.' },
  MI: { cap: 280, pctCap: 5, verify: true, note: 'Lesser of the dollar cap or 5% of price; CPI-indexed.' },
  MN: { cap: 350 },
  MO: { cap: 621, verify: true, note: 'CPI-indexed every year.' },
  NY: { cap: 175, note: 'Must be shown as optional and not a DMV fee.' },
  OH: { cap: 398, pctCap: 10, verify: true, note: 'Lesser of the dollar cap or 10% of price; CPI-indexed.' },
  OR: { cap: 250 },
  TX: { cap: 225, presumed: true, note: 'OCCC presumed-reasonable amount. Higher is only allowed if the dealer filed a cost analysis with the OCCC.' },
  WA: { cap: 200 },
};

export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
const STATE_NAMES = Object.fromEntries(US_STATES);
export const isState = (code) => Object.prototype.hasOwnProperty.call(STATE_NAMES, code);

export function checkDocFee(docFee, state, sellingPrice) {
  if (!(docFee > 0)) return { status: 'none', text: 'No doc fee entered.' };
  const row = DOC_FEE_TABLE[state];
  const stateName = STATE_NAMES[state] || state || 'your state';
  const verifyNote = row?.verify ? ' (cap figure needs verification — it moves yearly or sources disagree)' : '';
  if (row) {
    let limit = row.cap;
    if (row.pctCap && sellingPrice > 0) limit = Math.min(limit, (sellingPrice * row.pctCap) / 100);
    const over = docFee - limit;
    const kind = row.presumed ? 'presumed-reasonable amount' : 'cap';
    if (over > 0.5) {
      return {
        status: 'flag',
        text: `Doc fee ${money(docFee)} is ${money(over)} over ${stateName}'s ${kind} of ${money(limit)}${verifyNote}.${row.note ? ' ' + row.note : ''}`,
      };
    }
    return { status: 'ok', text: `Doc fee ${money(docFee)} is within ${stateName}'s ${kind} of ${money(limit)}${verifyNote}.` };
  }
  if (docFee > UNCAPPED_HIGH) {
    return {
      status: 'flag',
      text: `Doc fee ${money(docFee)} is high. ${stateName} doesn't cap doc fees, but anything over ${money(UNCAPPED_HIGH)} is worth pushing on — it's pure dealer profit.`,
    };
  }
  return { status: 'ok', text: `Doc fee ${money(docFee)}. ${stateName} doesn't cap doc fees; this is in the normal range.` };
}

// ── Junk add-on reference list ──────────────────────────────────────────
// Static domain knowledge. Matched case-insensitively against each fee/add-on
// name the visitor (or the photo extraction) entered. Order matters only for
// readability — first match wins.
export const JUNK_ADDONS = [
  { key: 'vin_etch', re: /\b(vin|window)\s*etch|etching|theft\s*(deterrent|protection|guard)|anti[-\s]?theft/i,
    label: 'VIN etching / theft protection', note: 'Usually $200–$400 for something a $25 kit does. Ask for it removed.' },
  { key: 'nitrogen', re: /nitrogen|n2\s*(fill|tire)|tire\s*fill/i,
    label: 'Nitrogen-filled tires', note: 'Air is already 78% nitrogen. No real benefit for a road car.' },
  { key: 'paint', re: /paint\s*(protect|seal|sealant|guard)|ceramic|clear\s*coat\s*protect|appearance\s*(package|protect)|exterior\s*protect/i,
    label: 'Paint / appearance protection', note: 'Dealer-applied sealant is typically a few dollars of product marked up hundreds. If you want ceramic or PPF, a detailer does it better for less.' },
  { key: 'fabric', re: /fabric|interior\s*(protect|guard|seal)|leather\s*(protect|guard)|scotch\s*guard/i,
    label: 'Fabric / interior protection', note: 'Spray-on protectant marked up heavily. Decline it.' },
  { key: 'undercoat', re: /undercoat|rust\s*(proof|protect)|rustproof/i,
    label: 'Undercoating / rustproofing', note: 'Modern cars come rust-protected from the factory. Rarely worth paying for.' },
  { key: 'dealer_prep', re: /dealer\s*prep|prep\s*fee|pdi|pre[-\s]?delivery/i,
    label: 'Dealer prep', note: 'The manufacturer already pays the dealer to prep new cars. Paying it again is double-dipping.' },
  { key: 'markup', re: /market\s*adjust|\badm\b|additional\s*dealer\s*markup|dealer\s*markup|addendum|premium\s*package/i,
    label: 'Market adjustment / dealer markup', note: 'Pure markup over MSRP. Always negotiable, often removable entirely.' },
  { key: 'pinstripe', re: /pinstrip|stripe/i,
    label: 'Pinstriping', note: 'Cosmetic add-on with a large markup.' },
  { key: 'wheel_locks', re: /wheel\s*lock|lug\s*lock|locking\s*lug/i,
    label: 'Wheel locks', note: 'About $40 retail. Often padded to $150+.' },
  { key: 'gps_tracker', re: /gps|tracker|tracking\s*device|lojack|recovery\s*system/i,
    label: 'GPS tracker / recovery system', note: 'Often pre-installed and then charged for. Ask what it actually is and decline if you didn\'t ask for it.' },
  { key: 'key_replace', re: /key\s*(replace|protect|fob\s*protect)/i,
    label: 'Key replacement plan', note: 'Usually a poor value. Decline unless the price is trivial.' },
  { key: 'dent', re: /\bdent\b|\bding\b|windshield\s*(protect|repair)|tire\s*(&|and)?\s*wheel/i,
    label: 'Dent / windshield / tire-and-wheel plan', note: 'High-margin product. Check whether your insurance already covers it.' },
  { key: 'gap', re: /\bgap\b/i,
    label: 'GAP insurance', note: 'Can be worth having on a small down payment, but dealer GAP is often 2–3x what your own insurer or credit union charges. Price it elsewhere.' },
  { key: 'warranty', re: /extended\s*warrant|service\s*contract|vehicle\s*service|vsc\b|powertrain\s*plan/i,
    label: 'Extended warranty / service contract', note: 'Optional and heavily marked up. Never required to get financing. You can buy one later, and the price is negotiable.' },
  { key: 'maintenance', re: /maintenance\s*(plan|package)|prepaid\s*maint/i,
    label: 'Prepaid maintenance', note: 'Optional. Compare against what the scheduled services would actually cost.' },
];

// Official / pass-through charges. Not junk — but the amount should match
// the state's real number, which the team member checks.
const GOVERNMENT_FEE_RE = /\b(tax|title|registration|reg\.?|license|plate|tag|dmv|state\s*fee|inspection|tire\s*tax|tire\s*fee|emissions?)\b/i;

export function classifyFee(name) {
  const n = String(name || '');
  const junk = JUNK_ADDONS.find((j) => j.re.test(n));
  if (junk) return { kind: 'junk', ...junk };
  if (GOVERNMENT_FEE_RE.test(n)) return { kind: 'government', label: 'Government / pass-through fee', note: 'Legitimate if it matches the state amount. Ask for the breakdown.' };
  return { kind: 'unknown', label: 'Other charge', note: 'Ask exactly what this is and whether it can come off.' };
}

// ── Payment math ────────────────────────────────────────────────────────
// Standard amortized payment. Rate is APR in percent.
export function monthlyPayment(principal, aprPct, months) {
  if (!(principal > 0) || !(months > 0)) return null;
  const r = (aprPct || 0) / 100 / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

// Inverse: what loan amount does a given payment support at this APR/term.
export function principalFromPayment(payment, aprPct, months) {
  if (!(payment > 0) || !(months > 0)) return null;
  const r = (aprPct || 0) / 100 / 12;
  if (r === 0) return payment * months;
  return (payment * (1 - Math.pow(1 + r, -months))) / r;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function money(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const neg = n < 0;
  const s = Math.round(Math.abs(n)).toLocaleString('en-US');
  return `${neg ? '-' : ''}$${s}`;
}
const money2 = (n) => (Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
const pct1 = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

// ── Normalization ───────────────────────────────────────────────────────
// One canonical shape for a submitted deal, whichever path (photo or
// manual) produced it. Everything numeric is a Number or null; strings are
// trimmed and length-capped.
const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);

export function normalizeDeal(raw = {}) {
  const car = raw.car || {};
  const price = raw.price || {};
  const trade = raw.trade || {};
  const pay = raw.payment || {};
  const dealer = raw.dealer || {};
  const fees = Array.isArray(raw.fees) ? raw.fees : [];
  const method = ['cash', 'finance', 'lease'].includes(pay.method) ? pay.method : '';
  const state = String(raw.state || '').trim().toUpperCase();
  return {
    state: isState(state) ? state : '',
    car: {
      condition: ['new', 'used'].includes(car.condition) ? car.condition : '',
      year: num(car.year),
      make: str(car.make, 60),
      model: str(car.model, 60),
      trim: str(car.trim, 80),
    },
    price: { msrp: num(price.msrp), selling: num(price.selling) },
    docFee: num(raw.docFee),
    fees: fees.slice(0, 25)
      .map((f) => ({ name: str(f?.name, 80), amount: num(f?.amount) }))
      .filter((f) => f.name || f.amount !== null),
    trade: {
      has: trade.has === true || trade.has === 'yes',
      year: num(trade.year), make: str(trade.make, 60), model: str(trade.model, 60),
      miles: num(trade.miles), payoff: num(trade.payoff), offer: num(trade.offer),
    },
    payment: {
      method,
      down: num(pay.down), apr: num(pay.apr), term: num(pay.term), monthly: num(pay.monthly),
      mileage: num(pay.mileage),
    },
    dealer: {
      name: str(dealer.name, 120),
      timing: ['this_week', 'this_month', 'just_looking'].includes(dealer.timing) ? dealer.timing : '',
    },
  };
}

export const TIMING_LABELS = { this_week: 'This week', this_month: 'This month', just_looking: 'Just looking' };

export const vehicleLabel = (car) =>
  [car.year, car.make, car.model, car.trim].filter(Boolean).join(' ') || 'Vehicle not specified';

// ── Section builders ────────────────────────────────────────────────────
// Each returns { body, flags } where body is the editable plain-text draft
// for that section and flags is a list of short issue strings that feed the
// fallback verdict and the push-back prompt.

function priceSection(deal, market) {
  const { msrp, selling } = deal.price;
  const lines = [];
  if (msrp > 0 && selling > 0) {
    const diff = selling - msrp;
    const p = (diff / msrp) * 100;
    lines.push(diff <= 0
      ? `Selling price ${money(selling)} is ${money(-diff)} under MSRP ${money(msrp)} (${pct1(p)}).`
      : `Selling price ${money(selling)} is ${money(diff)} over MSRP ${money(msrp)} (${pct1(p)}).`);
  } else if (selling > 0) {
    lines.push(`Selling price ${money(selling)}. No MSRP entered, so no MSRP comparison.`);
  } else {
    lines.push('No selling price entered.');
  }
  const flags = [];
  if (msrp > 0 && selling > msrp) flags.push(`selling price is ${money(selling - msrp)} over MSRP`);

  if (market?.found && market.value > 0) {
    const v = marketVerdict(selling, market.value);
    lines.push(`Market comparison: ${money(market.value)}${market.source ? ` (${market.source})` : ''}. Selling price is ${pct1(v.pct)} vs. market.`);
  } else {
    lines.push(`No market comparison found.${market?.reason ? ' ' + market.reason : ''}`);
  }
  return { body: lines.join('\n'), flags };
}

function feeSection(deal) {
  const lines = [];
  const flags = [];
  const doc = checkDocFee(deal.docFee, deal.state, deal.price.selling);
  lines.push(`Doc fee: ${doc.text}`);
  if (doc.status === 'flag') flags.push('doc fee over the cap/typical range');

  let junkTotal = 0;
  for (const f of deal.fees) {
    const c = classifyFee(f.name);
    const amt = f.amount !== null ? money(f.amount) : 'amount not entered';
    if (c.kind === 'junk') {
      junkTotal += f.amount || 0;
      lines.push(`FLAG — ${f.name || 'Unnamed item'} (${amt}): ${c.label}. ${c.note}`);
      flags.push(`${c.label.toLowerCase()} add-on${f.amount ? ` (${money(f.amount)})` : ''}`);
    } else if (c.kind === 'government') {
      lines.push(`${f.name} (${amt}): ${c.note}`);
    } else {
      lines.push(`CHECK — ${f.name || 'Unnamed item'} (${amt}): ${c.note}`);
    }
  }
  if (!deal.fees.length) lines.push('No other fees or add-ons entered.');
  if (junkTotal > 0) lines.push(`Flagged add-ons total ${money(junkTotal)}.`);
  lines.push(`(Doc-fee table as of ${DOC_FEE_TABLE_AS_OF}.)`);
  return { body: lines.join('\n'), flags, junkTotal };
}

function tradeSection(deal, tradeMarket) {
  const t = deal.trade;
  if (!t.has) return { body: 'No trade-in.', flags: [] };
  const lines = [];
  const flags = [];
  const label = [t.year, t.make, t.model].filter(Boolean).join(' ') || 'Trade-in';
  lines.push(`${label}${t.miles ? `, ${t.miles.toLocaleString('en-US')} miles` : ''}.`);
  if (t.offer !== null) lines.push(`Dealer offer: ${money(t.offer)}.`);
  if (t.payoff !== null) lines.push(`Payoff: ${money(t.payoff)}.`);
  if (t.offer !== null && t.payoff !== null) {
    const eq = t.offer - t.payoff;
    if (eq < 0) {
      lines.push(`Negative equity of ${money(-eq)} — that amount gets rolled into the new loan unless you pay it down.`);
      flags.push(`${money(-eq)} of negative equity on the trade`);
    } else {
      lines.push(`Equity: ${money(eq)} toward the new car.`);
    }
  }
  if (tradeMarket?.found && tradeMarket.value > 0) {
    lines.push(`Market comparison: ${money(tradeMarket.value)}${tradeMarket.source ? ` (${tradeMarket.source})` : ''}.`);
  } else {
    lines.push(`No market comparison found.${tradeMarket?.reason ? ' ' + tradeMarket.reason : ''} For a mainstream trade-in a collector-market comparable often doesn't exist at all.`);
  }
  lines.push('A firm trade number needs photos and the VIN either way.');
  return { body: lines.join('\n'), flags };
}

function paymentSection(deal) {
  const p = deal.payment;
  const lines = [];
  const flags = [];
  if (p.method === 'cash') return { body: 'Paying cash. No payment math needed.', flags };
  if (!p.method) return { body: 'Payment method not entered.', flags };

  const selling = deal.price.selling || 0;
  const feeTotal = (deal.docFee || 0) + deal.fees.reduce((s, f) => s + (f.amount || 0), 0);
  const t = deal.trade;
  const tradeEquity = t.has && t.offer !== null ? t.offer - (t.payoff || 0) : 0;

  if (p.method === 'finance') {
    const base = selling + feeTotal - (p.down || 0) - tradeEquity;
    lines.push(`Estimated amount financed (before sales tax and registration): ${money(selling)} price + ${money(feeTotal)} fees − ${money(p.down || 0)} down${tradeEquity > 0 ? ` − ${money(tradeEquity)} trade equity` : tradeEquity < 0 ? ` + ${money(-tradeEquity)} negative trade equity` : ''} = ${money(base)}.`);
    if (p.apr === null || !p.term) {
      lines.push('APR or term missing, so the payment can\'t be recomputed.');
      return { body: lines.join('\n'), flags };
    }
    const calc = monthlyPayment(base, p.apr, p.term);
    lines.push(`At ${p.apr}% APR over ${p.term} months, that's ${money2(calc)}/mo before tax.`);
    if (p.monthly > 0) {
      lines.push(`Quoted: ${money2(p.monthly)}/mo.`);
      const implied = principalFromPayment(p.monthly, p.apr, p.term);
      const gap = implied - base;
      lines.push(`The quoted payment supports a loan of about ${money(implied)} — ${money(Math.abs(gap))} ${gap >= 0 ? 'more' : 'less'} than the estimate above.`);
      // Sales tax + title/registration legitimately close part of the gap.
      // Allow up to ~10% of price for that; past it, something else is in
      // the loan.
      const allowance = selling * 0.1 + 500;
      if (gap > allowance) {
        lines.push(`MISMATCH — that's more than sales tax and registration usually explain. Ask for an itemized amount-financed breakdown; this is where add-ons and a marked-up rate hide.`);
        flags.push(`quoted payment implies ~${money(gap)} more financed than the numbers on the deal`);
      } else if (gap < -250) {
        lines.push('The quoted payment is lower than the math supports — confirm the APR and term are what you\'ll actually sign.');
        flags.push('quoted payment doesn\'t match the stated APR/term');
      } else {
        lines.push('Difference is in the range sales tax and registration would explain.');
      }
    }
    lines.push(`Total of payments: ${money((p.monthly || calc) * p.term)} over ${p.term} months.`);
    if (p.term > 72) flags.push(`${p.term}-month term`);
    if (p.apr >= 9) flags.push(`${p.apr}% APR`);
    return { body: lines.join('\n'), flags };
  }

  // Lease: residual and money factor aren't collected, so the payment can't
  // be fully recomputed — say that plainly and do what arithmetic we can.
  lines.push('Lease. A full payment check needs the residual value and money factor, which aren\'t on this form — ask the dealer for both in writing.');
  if (p.monthly > 0 && p.term > 0) {
    const total = (p.down || 0) + p.monthly * p.term;
    lines.push(`Total cost over the lease: ${money(p.down || 0)} down + ${money2(p.monthly)} × ${p.term} = ${money(total)} (${money2(total / p.term)}/mo effective, before fees due at signing).`);
    if (deal.price.msrp > 0) {
      const onePct = (p.monthly / deal.price.msrp) * 100;
      lines.push(`Monthly is ${onePct.toFixed(2)}% of MSRP.`);
    }
  }
  if (p.mileage) lines.push(`Mileage allowance: ${p.mileage.toLocaleString('en-US')} miles/year. Check the per-mile overage charge.`);
  if ((p.down || 0) > 3000) flags.push(`${money(p.down)} down on a lease (lost if the car is totaled)`);
  return { body: lines.join('\n'), flags };
}

// Qualitative verdict when there's no market number: counts red flags from
// the fee X-ray and payment math. Deliberately coarse — the draft says it
// isn't price-based, and a team member makes the call.
function fallbackVerdict(flagCount) {
  if (flagCount >= 3) return { ...VERDICT.walk, basis: 'qualitative' };
  if (flagCount >= 1) return { ...VERDICT.negotiable, basis: 'qualitative' };
  return { ...VERDICT.negotiable, basis: 'qualitative', clean: true };
}

function verdictSection(deal, market, flags) {
  const mv = market?.found ? marketVerdict(deal.price.selling, market.value) : null;
  if (mv) {
    return {
      verdict: mv,
      body: `${mv.label}. Selling price is ${pct1(mv.pct)} vs. the market comparison of ${money(market.value)}.`,
    };
  }
  const v = fallbackVerdict(flags.length);
  const why = flags.length
    ? `Based on the fees and payment math: ${flags.slice(0, 3).join('; ')}.`
    : 'No fee or payment problems found in what was entered.';
  return {
    verdict: v,
    body: `${v.label}. ${why}\nNote: this verdict isn't based on a market price — no market comparison was found for this car.`,
  };
}

export const WHITE_GLOVE_LINE =
  "Want us to negotiate it for you? With White Glove we take over the deal — numbers, paperwork, and delivery. Start here: https://theexactmatch.com/white-glove";

// The draft as stored on the record. `needsInput` marks a section a team
// member must fill in or confirm before sending (market research, and the
// push-back items if the AI call failed).
export const SECTION_ORDER = ['verdict', 'price', 'fees', 'trade', 'payment', 'pushback', 'upsell'];
export const SECTION_TITLES = {
  verdict: 'Verdict',
  price: 'Price check',
  fees: 'Fee X-ray',
  trade: 'Trade-in',
  payment: 'Payment math',
  pushback: 'Top 3 things to push back on',
  upsell: 'Want it handled?',
};

export function buildDraft(deal, { market, tradeMarket, pushback } = {}) {
  const price = priceSection(deal, market);
  const fees = feeSection(deal);
  const trade = tradeSection(deal, tradeMarket);
  const payment = paymentSection(deal);
  const flags = [...price.flags, ...fees.flags, ...trade.flags, ...payment.flags];
  const verdict = verdictSection(deal, market, flags);

  const marketMissing = !market?.found;
  const tradeMissing = deal.trade.has && !tradeMarket?.found;
  const pushbackItems = Array.isArray(pushback) && pushback.length ? pushback.slice(0, 3) : null;

  return {
    verdict_key: verdict.verdict.key,
    verdict_basis: verdict.verdict.basis,
    flags,
    sections: {
      verdict: { body: verdict.body, needsInput: marketMissing },
      price: { body: price.body, needsInput: marketMissing },
      fees: { body: fees.body, needsInput: false },
      trade: { body: trade.body, needsInput: tradeMissing },
      payment: { body: payment.body, needsInput: false },
      pushback: {
        body: pushbackItems
          ? pushbackItems.map((p, i) => `${i + 1}. ${p}`).join('\n')
          : 'NEEDS INPUT — the push-back items couldn\'t be generated automatically. Write the top 3 here.',
        needsInput: !pushbackItems,
      },
      upsell: { body: WHITE_GLOVE_LINE, needsInput: false },
    },
  };
}

// Recompute just the market-dependent sections after a team member enters a
// market value they researched by hand. Leaves every other (possibly edited)
// section alone.
export function applyManualMarket(deal, draft, { marketValue, marketSource, tradeValue, tradeSource }) {
  const next = structuredClone(draft);
  const market = marketValue > 0 ? { found: true, value: marketValue, source: marketSource || 'manual research' } : null;
  if (market) {
    const price = priceSection(deal, market);
    const mv = marketVerdict(deal.price.selling, market.value);
    next.sections.price = { body: price.body, needsInput: false };
    if (mv) {
      next.sections.verdict = { body: `${mv.label}. Selling price is ${pct1(mv.pct)} vs. the market comparison of ${money(market.value)}.`, needsInput: false };
      next.verdict_key = mv.key;
      next.verdict_basis = 'market';
    }
  }
  if (tradeValue > 0 && deal.trade.has) {
    const t = tradeSection(deal, { found: true, value: tradeValue, source: tradeSource || 'manual research' });
    next.sections.trade = { body: t.body, needsInput: false };
  }
  return next;
}

// Plain-text summary of the deal, used both as the push-back prompt input
// and as the "what you sent us" block in the email.
export function dealSummaryLines(deal) {
  const L = [];
  L.push(`Vehicle: ${deal.car.condition ? deal.car.condition + ' ' : ''}${vehicleLabel(deal.car)}`);
  L.push(`MSRP: ${money(deal.price.msrp)} · Selling price: ${money(deal.price.selling)}`);
  L.push(`Doc fee: ${money(deal.docFee)}`);
  for (const f of deal.fees) L.push(`Fee/add-on: ${f.name || 'Unnamed'} ${money(f.amount)}`);
  if (deal.trade.has) {
    const t = deal.trade;
    L.push(`Trade-in: ${[t.year, t.make, t.model].filter(Boolean).join(' ')}${t.miles ? `, ${t.miles} mi` : ''} · payoff ${money(t.payoff)} · dealer offer ${money(t.offer)}`);
  } else {
    L.push('Trade-in: none');
  }
  const p = deal.payment;
  if (p.method === 'finance') L.push(`Finance: ${money(p.down)} down, ${p.apr ?? '—'}% APR, ${p.term ?? '—'} months, quoted ${money2(p.monthly)}/mo`);
  else if (p.method === 'lease') L.push(`Lease: ${money(p.down)} down, ${money2(p.monthly)}/mo, ${p.term ?? '—'} months, ${p.mileage ?? '—'} mi/yr`);
  else if (p.method === 'cash') L.push('Paying cash');
  if (deal.dealer.name) L.push(`Dealer: ${deal.dealer.name}`);
  if (deal.dealer.timing) L.push(`Buying: ${TIMING_LABELS[deal.dealer.timing]}`);
  if (deal.state) L.push(`State: ${deal.state}`);
  return L;
}
