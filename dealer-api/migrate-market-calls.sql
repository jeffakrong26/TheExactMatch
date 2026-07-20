-- "Calls log" — a journal of market predictions Jeff makes (e.g. "I think
-- 997.1 GT3 prices firm up over the next quarter"), reviewed later against
-- real sold data. Did not exist before this migration despite being
-- referenced as a prerequisite for Update 5's auto-link feature — built now
-- from scratch. See adminListMarketCalls/adminCreateMarketCall/
-- adminGetMarketCall/adminResolveMarketCall in src/index.js.
CREATE TABLE market_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  year_start INTEGER,
  year_end INTEGER,
  call_text TEXT NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now')),
  review_date TEXT,              -- nullable = no specific target date
  resolution TEXT,               -- null (pending) | correct | incorrect | early | unclear
  resolution_note TEXT,
  resolved_at TEXT
);

CREATE INDEX idx_market_calls_review_date ON market_calls(review_date);
CREATE INDEX idx_market_calls_resolution ON market_calls(resolution);
