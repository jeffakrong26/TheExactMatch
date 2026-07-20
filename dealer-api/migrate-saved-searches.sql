-- Admin "Saved Searches" tool: Jeff enters vehicle-search criteria once,
-- it's checked daily via the same Auto.dev listing search Find My Car uses
-- (searchAutodevListings, no partner-dealer scoping), and a Brevo email
-- goes out when new matching listings show up. See checkSavedSearches/
-- adminListSavedSearches/adminCreateSavedSearch/adminUpdateSavedSearch/
-- adminDeleteSavedSearch/adminListSavedSearchMatches/
-- adminCheckSavedSearchNow in src/index.js.
CREATE TABLE saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  make TEXT, model TEXT, trim TEXT,
  year_min INTEGER, year_max INTEGER,
  price_max INTEGER, max_mileage INTEGER,
  zip TEXT,
  used INTEGER,              -- 1 = used only, 0 = new only, NULL = either
  alert_email TEXT NOT NULL DEFAULT 'theexactmatch@gmail.com',
  active INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every listing ever matched to a saved search, so re-checking never
-- re-notifies on the same VDP url (dealers occasionally relist the same
-- VIN under a new url, hence keying dedupe on vdp_url, not vin).
CREATE TABLE saved_search_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  vin TEXT, vdp_url TEXT NOT NULL,
  year INTEGER, make TEXT, model TEXT, trim TEXT,
  price INTEGER, mileage INTEGER,
  dealer_name TEXT, dealer_city TEXT, dealer_state TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT
);

CREATE UNIQUE INDEX idx_ssm_dedupe ON saved_search_matches(saved_search_id, vdp_url);
CREATE INDEX idx_ssm_search_id ON saved_search_matches(saved_search_id);
