-- Per-model (brand+model+trim) detail page data: a refresh-on-demand
-- "about" summary plus a full MSRP-to-today price curve. Scoped per model,
-- not per watchlist row, so every watchlist entry sharing the same
-- brand+model+trim shares one page. See getOrCreateCarProfile/
-- adminGetCarProfile/adminRefreshCarAbout/adminRefreshCarPriceCurve in
-- src/index.js.
--
-- trim is stored as '' rather than NULL for "no trim" (not NULL) — SQLite
-- treats every NULL as distinct for UNIQUE-constraint purposes, so two
-- inserts of the same brand+model with NULL trim would NOT collide and
-- would silently create duplicate rows. Always normalize to '' in
-- application code before reading/writing this table.
--
-- published_price_points and price_curve_refreshed_at aren't in the
-- original spec's schema sketch, but are needed to make the price-curve
-- section refresh-on-demand (like the about section) rather than re-running
-- a live web-search research call on every page view.
CREATE TABLE car_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT NOT NULL DEFAULT '',
  about_text TEXT,
  about_sources TEXT,              -- JSON array of {title, url, publisher}
  about_refreshed_at TEXT,         -- null until first refresh
  msrp_by_year TEXT,               -- JSON: [{year, msrp}] — original new pricing
  published_price_points TEXT,     -- JSON: [{year, avg_price, source}] from Classic.com/Hagerty research
  price_curve_refreshed_at TEXT,   -- null until first refresh
  UNIQUE(brand, model, trim)
);
