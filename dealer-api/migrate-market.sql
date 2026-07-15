-- The Tape: daily internal market-intelligence brief at /market. See
-- market.html (root static site) + the ingestMarket*/synthesizeMarketBrief
-- functions in src/index.js. Reuses this same DB (dealer-portal) so the
-- Samantha safety net can join market_items directly against partner_leads/
-- report_vehicles without a cross-Worker call.

-- One row per ingested intel item (incentive, recall, market move, news,
-- auction result, inventory signal). `hot` is set by the Samantha safety
-- net cross-check (an incentive matching an open partner_leads deal).
CREATE TABLE market_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- incentive | recall | market_move | news | auction | inventory_signal
  title TEXT NOT NULL,
  detail TEXT,
  source TEXT,                   -- nhtsa | autodev | manheim | bat | carsandbids | news:<domain> | manual
  source_url TEXT,
  brand TEXT,
  model TEXT,
  body_style TEXT, size TEXT, tier TEXT, electrified TEXT,
  region TEXT DEFAULT 'national', -- national | tx | houston | austin
  direction TEXT,                 -- up | down | neutral
  magnitude REAL,
  starts_at TEXT, ends_at TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  score REAL DEFAULT 0,
  hot INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_market_items_type ON market_items(type);
CREATE INDEX idx_market_items_expires_at ON market_items(expires_at);
CREATE INDEX idx_market_items_brand_model ON market_items(brand, model);

-- Daily computed snapshot for the tape + charts. One row per day.
CREATE TABLE market_daily (
  day TEXT PRIMARY KEY,          -- YYYY-MM-DD
  used_index REAL,               -- latest Manheim index value (monthly; carried forward)
  used_index_asof TEXT,
  hou_avg_dom REAL,
  atx_avg_dom REAL,
  dom_by_segment TEXT,           -- JSON: [{body_style,size,tier,dom}]
  tx_incentive_count INTEGER,
  brief_json TEXT,               -- Claude-generated brief (tape/headline/movers/etc)
  one_thing TEXT,                -- the daily education nugget (denormalized for quick access)
  synthesis_ok INTEGER NOT NULL DEFAULT 1  -- 0 if synthesis failed this day (drives the fallback email)
);

-- Every "one thing" education topic ever sent, so synthesis can avoid repeats.
CREATE TABLE market_one_thing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  topic TEXT NOT NULL
);

-- Phase 2: demand weighting from client requests. Logged now (Find My Car /
-- Sell My Car submissions), scored against later once enough data accrues.
CREATE TABLE demand_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,                   -- find_my_car | sell_my_car
  brand TEXT, model TEXT,
  body_style TEXT, size TEXT, tier TEXT, electrified TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_demand_signals_brand_model ON demand_signals(brand, model);

-- Self-tracked days-on-market fallback for the Auto.dev inventory-signal
-- source: if Auto.dev's raw listing response doesn't expose a DOM/first-seen
-- field (unconfirmed as of writing), this table lets the daily ingestion
-- cron compute DOM itself by remembering the first day each VIN was seen in
-- a Houston/Austin radius search. A VIN not seen in today's search is
-- assumed sold/delisted and left alone (not deleted, so historical DOM at
-- last-seen is still queryable for a few days via the retention job).
CREATE TABLE market_inventory_watch (
  vin TEXT PRIMARY KEY,
  brand TEXT, model TEXT,
  body_style TEXT, size TEXT, tier TEXT, electrified TEXT,
  region TEXT NOT NULL,          -- houston | austin
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL
);

CREATE INDEX idx_market_inventory_watch_region ON market_inventory_watch(region);

-- Per-source last-success timestamp, for the /market "sources" footer row
-- (a silent scraper failure should be visible at a glance, not discovered
-- days later from a stale panel).
CREATE TABLE market_source_status (
  source TEXT PRIMARY KEY,       -- nhtsa | autodev | manheim | bat | carsandbids | news
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);
