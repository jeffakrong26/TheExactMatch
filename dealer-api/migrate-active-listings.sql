-- Active (for-sale, not-yet-sold) listing tracker for exotic_watchlist cars,
-- plus the data behind the weekly sold/disappeared report. Distinct from
-- market_items (which only records past completed sales for the exotic
-- corner) — this table follows a listing across its whole lifecycle: seen
-- while active, then resolved as either confirmed_sold (source itself
-- shows a completed sale) or disappeared_unconfirmed (dropped off the
-- source with no sold price ever published — the bucket Jeff manually
-- checks). See ingestBatActiveListings/ingestPCarMarketActiveListings/
-- ingestCollectingCarsActiveListings + resolveStaleActiveListings in
-- src/index.js.
CREATE TABLE active_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL REFERENCES exotic_watchlist(id),
  source TEXT NOT NULL,          -- bat | pcarmarket | collectingcars | web_search
  external_url TEXT NOT NULL,
  external_id TEXT,
  brand TEXT, model TEXT, trim TEXT, year INTEGER, mileage INTEGER,
  price_asking REAL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active', -- active | confirmed_sold | disappeared_unconfirmed | manual_resolved
  sold_price REAL,
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE UNIQUE INDEX idx_active_listings_url ON active_listings(external_url);
CREATE INDEX idx_active_listings_watchlist ON active_listings(watchlist_id);
CREATE INDEX idx_active_listings_status ON active_listings(status);
