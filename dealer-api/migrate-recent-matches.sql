-- Recent Matches: admin-manageable success-story cards shown as a teaser on
-- Find My Car and as their own crawlable /recent-matches + /recent-matches/:slug
-- pages, so a new match goes live from the admin panel with no code deploy.
CREATE TABLE recent_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  card_title TEXT NOT NULL,
  photo_key TEXT,
  savings_amount INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
