// Sanity checks for the deterministic Deal Review math (src/deal-review.js).
// Run: node dealer-api/scripts/deal-review-selftest.mjs
import assert from 'node:assert/strict';
import { colorFamily, cleanColorPref, colorBonusMiles, EXTERIOR_MATCH_MILES, INTERIOR_MATCH_MILES } from '../src/colors.js';
import { excludeReason, parseTrimFacets, matchTrim, explainSelection, applyMarketResult, usedCompWindow, selectComps, summarizeComps, normalizeVin, marketVerdict, monthlyPayment, principalFromPayment, checkDocFee, classifyFee, normalizeDeal, buildDraft, applyManualMarket } from '../src/deal-review.js';

// Verdict thresholds: <= -5% good, >= +3% walk, between negotiable.
assert.equal(marketVerdict(95000, 100000).key, 'good');
assert.equal(marketVerdict(95001, 100000).key, 'negotiable');
assert.equal(marketVerdict(102999, 100000).key, 'negotiable');
assert.equal(marketVerdict(103000, 100000).key, 'walk');
assert.equal(marketVerdict(100000, null), null);

// Amortization: $30,000 at 6% for 60 months = $579.98.
assert.equal(monthlyPayment(30000, 6, 60).toFixed(2), '579.98');
assert.equal(monthlyPayment(12000, 0, 60), 200);
assert.equal(Math.round(principalFromPayment(579.98, 6, 60)), 30000);

assert.equal(checkDocFee(85, 'CA', 40000).status, 'ok');
assert.equal(checkDocFee(150, 'CA', 40000).status, 'flag');
assert.equal(checkDocFee(899, 'TX', 40000).status, 'flag');
assert.equal(checkDocFee(399, 'FL', 40000).status, 'ok');
assert.equal(checkDocFee(999, 'FL', 40000).status, 'flag');
assert.equal(checkDocFee(300, 'OH', 2000).status, 'flag'); // 10% of $2,000 = $200

assert.equal(classifyFee('VIN Etching').kind, 'junk');
assert.equal(classifyFee('Nitrogen tires').kind, 'junk');
assert.equal(classifyFee('Title & Registration').kind, 'government');
assert.equal(classifyFee('Accident forgiveness').kind, 'unknown');

const deal = normalizeDeal({
  state: 'tx',
  car: { condition: 'new', year: '2026', make: 'Audi', model: 'Q5', trim: 'Premium Plus' },
  price: { msrp: '$52,000', selling: '51,500' },
  docFee: 899,
  fees: [{ name: 'Paint protection', amount: 1295 }, { name: 'TT&L', amount: 3400 }],
  trade: { has: 'yes', year: 2019, make: 'Honda', model: 'CR-V', miles: 61000, payoff: 14000, offer: 12500 },
  payment: { method: 'finance', down: 3000, apr: 7.9, term: 72, monthly: 975 },
  dealer: { name: 'Example Audi', timing: 'this_week' },
});
assert.equal(deal.state, 'TX');
const draft = buildDraft(deal, { market: { status: 'thin' }, tradeMarket: { status: 'error' } });
assert.equal(draft.verdict_basis, 'qualitative');
assert.equal(draft.sections.price.needsInput, true);
assert.equal(draft.sections.pushback.needsInput, true);
assert.match(draft.sections.verdict.body, /isn't based on comparable listings\. Not enough comparable listings found\./);
assert.match(draft.sections.trade.body, /Market data unavailable\./);
assert.match(draft.sections.fees.body, /FLAG — Paint protection/);
assert.match(draft.sections.trade.body, /Negative equity of \$1,500/);
const after = applyManualMarket(deal, draft, { marketValue: 49000 });
assert.equal(after.verdict_key, 'walk');
assert.equal(after.sections.price.needsInput, false);
// Mileage kept only for used cars; VIN shape-checked (17 chars, no I/O/Q).
assert.equal(normalizeDeal({ car: { condition: 'used', mileage: '32,500' } }).car.mileage, 32500);
assert.equal(normalizeDeal({ car: { condition: 'new', mileage: '32500' } }).car.mileage, null);
assert.equal(normalizeDeal({ car: { condition: 'used', mileage: '-5' } }).car.mileage, null);
assert.equal(normalizeVin('wba5r1c50kfh12345'), 'WBA5R1C50KFH12345');
assert.equal(normalizeVin('WBA5R1C50KFH1234'), '');   // 16 chars
assert.equal(normalizeVin('WBA5R1C50KFH1234O'), '');  // contains O
assert.equal(normalizeVin(''), '');
// ── Listings comparison ──
assert.deepEqual(usedCompWindow(2021, 3000), { yearMin: 2020, yearMax: 2023, milesMin: 0, milesMax: 8000 });
const L = (id, year, miles, price, extra = {}) => ({ id, year, trim: 'SE', miles, price, dealer: 'D' + id, city: 'Austin', state: 'TX', url: 'https://x/' + id, sellerType: 'dealer', ...extra });
const listings = [
  L(1, 2021, 30000, 25000), L(2, 2022, 30000, 26000), L(3, 2021, 31000, 24000),
  L(4, 2021, 36000, 99999),                       // outside +5,000
  L(5, 2019, 30100, 99999),                       // year below year-1
  L(6, 2024, 29000, 99999),                       // year above year+2
  L(7, 2021, 30500, null),                        // no price
  L(8, 2021, null, 99999),                        // no miles
  L(9, 2021, 30200, 99999, { trim: 'XSE' }),      // different trim
  L(10, 2021, 30200, 99999, { sellerType: 'fsbo' }), // private party
  L(1, 2021, 30000, 25000),                       // duplicate
];
const used = selectComps(listings, { kind: 'used', year: 2021, miles: 30000, trim: 'se' });
assert.deepEqual(used.map(c => c.id), [1, 2, 3]);   // gap 0 (2021 before 2022 on year), then 1,000
const sum = summarizeComps(used, { kind: 'used', year: 2021, miles: 30000, scope: 'state', state: 'TX' });
assert.equal(sum.average, 25000); assert.equal(sum.low, 24000); assert.equal(sum.high, 26000);
assert.equal(summarizeComps(used.slice(0, 2), { kind: 'used', year: 2021, miles: 30000 }), null); // fewer than 3
const many = Array.from({ length: 14 }, (_, i) => L(100 + i, 2021, 30000 + i * 300, 20000 + i * 100));
const top = selectComps(many, { kind: 'used', year: 2021, miles: 30000, trim: 'SE' });
assert.equal(top.length, 10); assert.equal(top[9].id, 109);
const tradeComps = selectComps([L(1, 2019, 60000, 15000, { trim: 'EX' }), L(2, 2020, 61000, 16000, { trim: 'LX' }), L(3, 2018, 59000, 14000, { trim: '' })], { kind: 'trade', year: 2019, miles: 60000 });
assert.equal(tradeComps.length, 3); // trade-in ignores trim
const newComps = selectComps([L(1, 2026, 5, 50000), L(2, 2026, 10, 52000), L(3, 2025, 5, 40000), L(4, 2026, 0, 51000)], { kind: 'new', year: 2026, trim: 'SE' });
assert.deepEqual(newComps.map(c => c.id).sort(), [1, 2, 4]);

const usedDeal = normalizeDeal({ state: 'TX', car: { condition: 'used', year: 2021, make: 'Toyota', model: 'Camry', trim: 'SE', mileage: 30000 },
  price: { selling: 27000 }, trade: { has: 'yes', year: 2016, make: 'Honda', model: 'Civic', miles: 90000, offer: 8000 }, payment: { method: 'cash' } });
const tradeSum = summarizeComps(selectComps([L(1, 2016, 90000, 11000), L(2, 2017, 91000, 12000), L(3, 2015, 88000, 10000)], { kind: 'trade', year: 2016, miles: 90000 }), { kind: 'trade', year: 2016, miles: 90000, scope: 'nationwide' });
const d2 = buildDraft(usedDeal, { market: sum, tradeMarket: tradeSum });
assert.equal(d2.verdict_key, 'walk');            // 27,000 vs 25,000 = +8%
assert.equal(d2.verdict_basis, 'market');
assert.match(d2.sections.price.body, /Average asking price of 3 comparable listings: \$25,000 \(range \$24,000–\$26,000\)\. Comps are 2020–2023, 25,000–35,000 miles, Texas\./);
assert.match(d2.sections.price.body, /Closest listing: 2021 SE, 30,000 miles, \$25,000, D1 in Austin, TX — https:\/\/x\/1/);
assert.match(d2.sections.trade.body, /not what a dealer would pay on a trade/);
assert.match(d2.sections.trade.body, /Dealer offer \$8,000 vs\. retail average \$11,000: \$3,000 below/);
assert.match(d2.sections.trade.body, /firm trade number needs photos and the VIN/);
assert.match(buildDraft(usedDeal, { market: { ...sum, scope: 'nationwide', searchedState: 'TX' } }).sections.price.body, /nationwide \(fewer than 3 in Texas\)\./);
for (const k of Object.keys(d2.sections)) assert.doesNotMatch(d2.sections[k].body, /market value|sells for/i, k);
// Trim resolution against Marketcheck's own trim list.
const avail = parseTrimFacets({ trim: [{ item: 'SE Hybrid', count: 4 }, { item: 'XLE', count: 9 }, { item: 'SE', count: 7 }] });
assert.deepEqual(avail.map(f => f.trim), ['XLE', 'SE', 'SE Hybrid']);
assert.equal(matchTrim(avail, 'se'), 'SE');
assert.equal(matchTrim(avail, 'S.E.'), 'SE');
assert.equal(matchTrim(avail, 'LE'), null);              // not listed: no loosening
assert.equal(matchTrim(parseTrimFacets({ trim: [{ item: 'SE Hybrid', count: 4 }] }), 'SE'), null);
assert.deepEqual(parseTrimFacets(null), []);
const why = explainSelection(listings, { kind: 'used', year: 2021, miles: 30000, trim: 'SE' });
assert.deepEqual(why, { returned: 11, noPrice: 1, privateParty: 1, wrongTrim: 1, outsideYears: 2, noMiles: 1, outsideMiles: 1, duplicate: 1 });
const usedT = { kind: 'used', year: 2021, miles: 30000, trim: 'SE' };
assert.equal(excludeReason(L(1, 2021, 30000, 25000), usedT), null);
assert.equal(excludeReason(L(9, 2021, 30200, 99999, { trim: 'XSE' }), usedT), 'other trim: XSE');
assert.equal(excludeReason(L(7, 2021, 30500, null), usedT), 'no price');
assert.equal(excludeReason(L(4, 2021, 36000, 1), usedT), 'outside mileage window');
assert.equal(excludeReason(L(5, 2019, 30100, 1), usedT), 'outside year window');
assert.equal(excludeReason(L(2, 2025, 5, 1, { trim: 'XSE' }), { kind: 'trade', year: 2025, miles: 10 }), null); // trade ignores trim
const rerun = applyMarketResult(usedDeal, buildDraft(usedDeal, { market: { status: 'thin' } }), { ...sum, trimOverride: 'SE' });
assert.equal(rerun.verdict_basis, 'market');
assert.match(rerun.sections.price.body, /Compared against the SE trim \(chosen by a team member; the trim entered was SE\)/);
// Used cars compare to the listing price, new cars to MSRP; each field is
// only kept for its own condition.
const usedL = normalizeDeal({ car: { condition: 'used' }, price: { msrp: '40000', listing: '27,995', selling: '28500' } });
assert.equal(usedL.price.msrp, null); assert.equal(usedL.price.listing, 27995);
const usedLDraft = buildDraft(usedL, { market: { status: 'thin' } });
assert.match(usedLDraft.sections.price.body, /Selling price \$28,500 is \$505 over the listing price \$27,995 \(\+1\.8%\)\./);
assert.ok(usedLDraft.flags.includes('selling price is $505 over the listing price'));
assert.match(buildDraft(normalizeDeal({ car: { condition: 'used' }, price: { selling: '28500' } }), {}).sections.price.body, /No listing price entered/);
const newM = normalizeDeal({ car: { condition: 'new' }, price: { msrp: '40000', listing: '1', selling: '39000' } });
assert.equal(newM.price.listing, null);
assert.match(buildDraft(newM, {}).sections.price.body, /\$1,000 under MSRP \$40,000/);
// Find My Car color preference: marketing names map to basic families,
// hue words beat finish words, and a match is only a small distance credit.
for (const [name, fam] of [['Ruby Flare Pearl', 'Red'], ['Pearl White', 'White'], ['Crystal Black Pearl', 'Black'], ['Blue Pearl', 'Blue'],
  ['Magnetic Gray Metallic', 'Gray'], ['Lunar Silver', 'Silver'], ['Wind Chill Pearl', 'White'], ['Carbon Black', 'Black'], ['Desert Sand', 'Beige'], ['Hellayella', null]]) {
  assert.equal(colorFamily(name), fam, name);
}
for (const [name, fam] of [['Charcoal Black', 'Black'], ['Cognac', 'Beige/Tan'], ['Ash', 'Gray'], ['Ivory White', 'White/Cream'], ['Jet Black/Light Ash', 'Black']]) {
  assert.equal(colorFamily(name, 'interior'), fam, name);
}
assert.equal(cleanColorPref('blue', 'exterior'), 'Blue');
assert.equal(cleanColorPref('Beige/Tan', 'interior'), 'Beige/Tan');
assert.equal(cleanColorPref('Beige/Tan', 'exterior'), null);
assert.equal(cleanColorPref('No preference', 'exterior'), null);
assert.equal(colorBonusMiles({ exterior_color: 'Rhapsody Blue', interior_color: 'Black Leather' }, { exterior: 'Blue', interior: 'Black' }), EXTERIOR_MATCH_MILES + INTERIOR_MATCH_MILES);
assert.equal(colorBonusMiles({ exterior_color: 'Super White', interior_color: null }, { exterior: 'Blue', interior: 'Black' }), 0);
assert.equal(colorBonusMiles({ exterior_color: 'Rhapsody Blue' }, null), 0);
console.log(d2.sections.price.body);
console.log(draft.sections.payment.body);
console.log('deal-review selftest: ok');
