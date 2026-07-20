-- The Tape's exotic watchlist: a runtime CRUD table so Jeff can tune which
-- cars get tracked/prioritized in the exotic corner without a coding session
-- (see market/watchlist.html + the adminWatchlist* handlers in src/index.js).
-- Seed rows below are the STARTING state only, loaded once here; after this
-- migration runs, all changes go through the admin UI.
CREATE TABLE exotic_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,           -- e.g. "911" (generation lives in year_start/year_end, not model)
  trim TEXT,                     -- e.g. "GT3", "GT3 RS", "Turbo S" (nullable)
  year_start INTEGER,            -- nullable = no lower bound
  year_end INTEGER,              -- nullable = no upper bound ("and newer")
  tier INTEGER NOT NULL,         -- 1 = core focus, 2 = modern halo, 3 = ultra-luxury
  max_mileage INTEGER,           -- nullable = no filter
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_exotic_watchlist_brand_model ON exotic_watchlist(brand, model);
CREATE INDEX idx_exotic_watchlist_active_tier ON exotic_watchlist(active, tier);

-- Watchlist-match columns on market_items. `tier` already exists on this
-- table as the taxonomy tier (mainstream|luxury|exotic TEXT) — watchlist_tier
-- is a distinct concept (1/2/3 priority INTEGER from exotic_watchlist), kept
-- under its own name to avoid colliding with that column.
ALTER TABLE market_items ADD COLUMN watchlist_id INTEGER REFERENCES exotic_watchlist(id);
ALTER TABLE market_items ADD COLUMN watchlist_tier INTEGER;
ALTER TABLE market_items ADD COLUMN mileage INTEGER;
ALTER TABLE market_items ADD COLUMN below_mileage_threshold INTEGER;

CREATE INDEX idx_market_items_watchlist_id ON market_items(watchlist_id);

-- ── Tier 1 — core focus, low-mileage priority (max_mileage 40,000) ──
INSERT INTO exotic_watchlist (brand, model, trim, year_start, year_end, tier, max_mileage, notes) VALUES
  ('Ferrari', '360', 'Modena', NULL, NULL, 1, 40000, NULL),
  ('Ferrari', '360', 'Challenge Stradale', NULL, NULL, 1, 40000, NULL),
  ('Ferrari', 'F430', NULL, NULL, NULL, 1, 40000, NULL),
  ('Ferrari', 'F430', 'Scuderia', NULL, NULL, 1, 40000, NULL),
  ('Ferrari', '550', 'Maranello', NULL, NULL, 1, 40000, NULL),
  ('Ferrari', '575', 'Maranello', NULL, NULL, 1, 40000, NULL),
  ('Ferrari', '599', 'GTB Fiorano', NULL, NULL, 1, 40000, NULL),
  ('Lamborghini', 'Gallardo', NULL, NULL, 2008, 1, 40000, 'Early V10 only'),
  ('Lamborghini', 'Murciélago', NULL, NULL, NULL, 1, 40000, NULL),
  ('Lamborghini', 'Murciélago', 'LP640', NULL, NULL, 1, 40000, NULL),
  ('Porsche', '911', 'GT3', 1999, 2004, 1, 40000, '996 generation'),
  ('Porsche', '911', 'GT2', 1999, 2004, 1, 40000, '996 generation'),
  ('Porsche', '911', 'Turbo', 1999, 2004, 1, 40000, '996 generation'),
  ('Porsche', '911', 'GT3', 2005, 2008, 1, 40000, '997.1 generation'),
  ('Porsche', '911', 'GT3 RS', 2005, 2008, 1, 40000, '997.1 generation'),
  ('Porsche', '911', 'Turbo', 2005, 2012, 1, 40000, '997 generation'),
  ('Porsche', '911', 'GT2', 2005, 2012, 1, 40000, '997 generation');

-- ── Tier 2 — modern halo cars (no mileage filter) ──
INSERT INTO exotic_watchlist (brand, model, trim, year_start, year_end, tier, max_mileage, notes) VALUES
  ('Porsche', '911', 'GT3', 2012, 2019, 2, NULL, '991 generation'),
  ('Porsche', '911', 'GT3', 2019, NULL, 2, NULL, '992 generation'),
  ('Porsche', '911', 'GT3 RS', 2019, NULL, 2, NULL, '992 generation'),
  ('Porsche', '911', 'Turbo S', 2019, NULL, 2, NULL, '992 generation'),
  ('Ferrari', '458', 'Italia', NULL, NULL, 2, NULL, NULL),
  ('Ferrari', '458', 'Speciale', NULL, NULL, 2, NULL, NULL),
  ('Ferrari', '488', 'GTB', NULL, NULL, 2, NULL, NULL),
  ('Ferrari', '488', 'Pista', NULL, NULL, 2, NULL, NULL),
  ('Lamborghini', 'Huracán', NULL, NULL, NULL, 2, NULL, NULL),
  ('Lamborghini', 'Aventador', NULL, NULL, NULL, 2, NULL, NULL),
  ('McLaren', '570S', NULL, NULL, NULL, 2, NULL, NULL),
  ('McLaren', '720S', NULL, NULL, NULL, 2, NULL, NULL);

-- ── Tier 3 — ultra-luxury (no mileage filter, lighter tracking) ──
INSERT INTO exotic_watchlist (brand, model, trim, year_start, year_end, tier, max_mileage, notes) VALUES
  ('Rolls-Royce', 'Ghost', NULL, NULL, NULL, 3, NULL, NULL),
  ('Rolls-Royce', 'Cullinan', NULL, NULL, NULL, 3, NULL, NULL),
  ('Bentley', 'Continental GT', NULL, NULL, NULL, 3, NULL, NULL),
  ('Land Rover', 'Range Rover', 'SV', NULL, NULL, 3, NULL, NULL);
