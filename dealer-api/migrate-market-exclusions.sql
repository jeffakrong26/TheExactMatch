-- Self-service exclusion rules for the exotic corner ingestion filter (spec:
-- Update 3, the "not relevant" feedback loop). Every scraped auction
-- listing that clears the vehicle_reference/exotic_watchlist gate is also
-- checked against these rules before being stored; a match here means
-- discard, same as a vehicle_reference miss. Rules accumulate two ways:
-- seeded here at build time (listing_keyword defaults below), and going
-- forward via the "Not relevant" action on /market (see
-- adminMarketItemNotRelevant in src/index.js) and manageable at
-- /market/exclusions without a deploy.
CREATE TABLE market_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,          -- listing_keyword | brand_model | brand_model_trim
  brand TEXT,
  model TEXT,
  trim TEXT,
  keyword TEXT,                 -- for scope=listing_keyword
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_market_exclusions_scope_active ON market_exclusions(scope, active);

-- Default keyword rules — replaces the previously hardcoded
-- JUNK_LISTING_KEYWORDS list in src/index.js so these are admin-editable
-- from day one rather than requiring a code change to add one.
INSERT INTO market_exclusions (scope, keyword, reason) VALUES
  ('listing_keyword', 'chassis', 'Seeded default: parts/chassis-only listing, not a complete vehicle'),
  ('listing_keyword', 'drivetrain only', 'Seeded default: drivetrain-only listing, not a complete vehicle'),
  ('listing_keyword', 'parts car', 'Seeded default: parts car, not a complete vehicle'),
  ('listing_keyword', 'parts only', 'Seeded default: parts-only listing, not a complete vehicle'),
  ('listing_keyword', 'for parts', 'Seeded default: parts-only listing, not a complete vehicle'),
  ('listing_keyword', 'project car', 'Seeded default: project car, not a clean-example comp'),
  ('listing_keyword', 'project', 'Seeded default: project car, not a clean-example comp'),
  ('listing_keyword', 'restoration project', 'Seeded default: project car, not a clean-example comp'),
  ('listing_keyword', 'non-running', 'Seeded default: non-running vehicle'),
  ('listing_keyword', 'non running', 'Seeded default: non-running vehicle'),
  ('listing_keyword', 'not running', 'Seeded default: non-running vehicle'),
  ('listing_keyword', 'no engine', 'Seeded default: incomplete vehicle, no engine'),
  ('listing_keyword', 'missing engine', 'Seeded default: incomplete vehicle, no engine'),
  ('listing_keyword', 'engine out', 'Seeded default: incomplete vehicle, no engine'),
  ('listing_keyword', 'rolling shell', 'Seeded default: bare shell, not a complete vehicle'),
  ('listing_keyword', 'rolling chassis', 'Seeded default: bare chassis, not a complete vehicle'),
  ('listing_keyword', 'salvage', 'Seeded default: salvage title/parts listing'),
  ('listing_keyword', 'basket case', 'Seeded default: incomplete disassembled vehicle'),
  ('listing_keyword', 'donor car', 'Seeded default: parts-donor listing, not a complete vehicle'),
  ('listing_keyword', 'shell only', 'Seeded default: bare shell, not a complete vehicle'),
  ('listing_keyword', 'parting out', 'Seeded default: being parted out, not a complete vehicle'),
  ('listing_keyword', 'stripped chassis', 'Seeded default: stripped chassis, not a complete vehicle');
