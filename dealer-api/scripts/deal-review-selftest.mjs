// Sanity checks for the deterministic Deal Review math (src/deal-review.js).
// Run: node dealer-api/scripts/deal-review-selftest.mjs
import assert from 'node:assert/strict';
import { normalizeVin, marketVerdict, monthlyPayment, principalFromPayment, checkDocFee, classifyFee, normalizeDeal, buildDraft, applyManualMarket } from '../src/deal-review.js';

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
const draft = buildDraft(deal, { market: { found: false, reason: 'test' }, tradeMarket: { found: false } });
assert.equal(draft.verdict_basis, 'qualitative');
assert.equal(draft.sections.price.needsInput, true);
assert.equal(draft.sections.pushback.needsInput, true);
assert.match(draft.sections.verdict.body, /isn't based on a market price/);
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
console.log(draft.sections.payment.body);
console.log('deal-review selftest: ok');
