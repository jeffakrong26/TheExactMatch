-- Fixes The Tape's DOM metric: it was computed as a same-day snapshot of
-- currently-active listings' current age, which is inherently noisy (a
-- small active-listing pool means a few listings closing/posting can swing
-- the average 20+ days overnight). Correct approach per spec: DOM only from
-- CLOSED listings, as a trailing 7-day rolling average per
-- body_style/size/tier/region bucket, with a minimum-sample-size rollup.
-- See ingestAutodevInventorySignals / rollupDomBySegment in src/index.js.

-- Marks a market_inventory_watch row as closed the day it drops out of the
-- daily Auto.dev fetch after having been open (NULL = still active).
ALTER TABLE market_inventory_watch ADD COLUMN closed_date TEXT;

-- One row per closed listing — the only source DOM figures are computed
-- from. dom = (last_seen_date - first_seen_date) in days, recorded at
-- closure so this table accumulates the trailing history needed for the
-- rolling average (never recomputed from live listings).
CREATE TABLE market_closed_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL,
  region TEXT NOT NULL,           -- houston | austin
  body_style TEXT NOT NULL, size TEXT NOT NULL, tier TEXT NOT NULL,
  dom INTEGER NOT NULL,
  closed_date TEXT NOT NULL
);

CREATE INDEX idx_market_closed_listings_region_date ON market_closed_listings(region, closed_date);
