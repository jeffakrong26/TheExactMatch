// Color preference for Find My Car — a nice-to-have, never a filter.
//
// Visitors pick a basic color from a dropdown; dealer listings carry
// marketing names ("Rhapsody Blue Metallic", "Cognac Nappa"). colorFamily()
// maps a listing's color to the same basic families, and colorBonusMiles()
// turns matches into a small distance credit used only when ordering the
// candidate pool: a matching car can move ahead of non-matching cars that
// are a little closer, but never jumps the partner-dealer ordering and is
// never required. Pure functions (no env), tested by
// scripts/deal-review-selftest.mjs.

// The dropdown values. Must match the <option> values on /find-my-car.
export const EXTERIOR_COLORS = ['Black', 'White', 'Gray', 'Silver', 'Blue', 'Red', 'Green', 'Brown', 'Beige', 'Gold', 'Orange', 'Yellow', 'Purple'];
export const INTERIOR_COLORS = ['Black', 'Gray', 'Beige/Tan', 'Brown', 'White/Cream', 'Red', 'Blue'];

// Keyword -> family, in two tiers. Hue words ("blue", "ruby") are checked
// first; weak words that are often just a finish or a mood ("pearl",
// "carbon", "midnight") only decide when no hue word is present, so
// "Ruby Flare Pearl" is Red and "Pearl White" is White.
const EXTERIOR_WORDS = [
  ['Silver', /silver|platinum|quicksilver|aluminum|titanium|sterling/, null],
  ['Gray', /gr[ae]y|graphite|gunmetal|charcoal|slate|nardo/, /magnetic|steel|cement|chalk|\bash\b/],
  ['White', /white|ivory|alabaster|bianco|blanc/, /pearl|glacier|frost|snow|polar/],
  ['Black', /black|ebony|onyx|obsidian|nero|noir/, /\bjet\b|carbon|midnight/],
  ['Blue', /blue|navy|azure|cobalt|sapphire|indigo|aqua|teal|cyan|\bblu\b|bleu/, null],
  ['Red', /red|crimson|ruby|maroon|burgundy|scarlet|cherry|cardinal|rosso|garnet/, /wine/],
  ['Green', /green|olive|emerald|jade|lime|verde/, /forest|army/],
  ['Brown', /brown|bronze|copper|mocha|espresso|chestnut|mahogany|chocolate|java/, null],
  ['Beige', /beige|\btan\b|champagne|khaki|taupe|cashmere|almond/, /sand|cream|desert/],
  ['Gold', /gold/, null],
  ['Orange', /orange|tangerine/, /amber|sunset/],
  ['Yellow', /yellow|giallo|lemon|canary/, null],
  ['Purple', /purple|violet|plum|amethyst|lavender|viola/, null],
];
const INTERIOR_WORDS = [
  ['Beige/Tan', /beige|\btan\b|saddle|camel|cognac|parchment|almond|macchiato|wheat|caramel|khaki|cashmere|sahara/, /sand|oyster/],
  ['Brown', /brown|espresso|mocha|chestnut|chocolate|mahogany|walnut|truffle|java|cocoa/, null],
  ['White/Cream', /white|cream|ivory|porcelain|alabaster|bianco/, /pearl/],
  ['Gray', /gr[ae]y|graphite|slate|titanium|silver|platinum|dove/, /\bash\b|charcoal|stone/],
  ['Black', /black|ebony|onyx|nero|obsidian/, /\bjet\b/],
  ['Red', /red|burgundy|bordeaux|oxblood|rosso|cardinal|merlot|garnet/, /tuscan/],
  ['Blue', /blue|navy|indigo/, null],
];

export function colorFamily(name, kind = 'exterior') {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  const words = kind === 'interior' ? INTERIOR_WORDS : EXTERIOR_WORDS;
  for (const [family, strong] of words) if (strong.test(s)) return family;
  for (const [family, , weak] of words) if (weak && weak.test(s)) return family;
  return null;
}

// Only accept known dropdown values; anything else means "no preference".
export function cleanColorPref(v, kind) {
  const list = kind === 'interior' ? INTERIOR_COLORS : EXTERIOR_COLORS;
  const s = String(v || '').trim();
  return list.find((c) => c.toLowerCase() === s.toLowerCase()) || null;
}

// Distance credit (miles) for a listing matching the preferences. Small on
// purpose: color is a tiebreaker between similar options, not a reason to
// send someone much farther away.
export const EXTERIOR_MATCH_MILES = 25;
export const INTERIOR_MATCH_MILES = 15;
export function colorBonusMiles(listing, prefs) {
  if (!prefs) return 0;
  let bonus = 0;
  if (prefs.exterior && colorFamily(listing.exterior_color, 'exterior') === prefs.exterior) bonus += EXTERIOR_MATCH_MILES;
  if (prefs.interior && colorFamily(listing.interior_color, 'interior') === prefs.interior) bonus += INTERIOR_MATCH_MILES;
  return bonus;
}
