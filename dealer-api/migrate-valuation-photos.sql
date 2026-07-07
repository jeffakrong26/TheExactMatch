-- Sell My Car: per-slot photo uploads for the tokenized photo upload page.
-- Slots are the fixed named shot list (front 3/4, rear 3/4, odometer, etc.);
-- 'tires' and 'issue' allow multiple rows per (valuation_id, slot).
CREATE TABLE valuation_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  valuation_id INTEGER NOT NULL REFERENCES vehicle_valuations(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_valuation_photos_valuation_id ON valuation_photos(valuation_id);
