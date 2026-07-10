-- Tracks when the admin last opened each dashboard section, so we can badge
-- "new since you last looked" counts (iOS-style) without touching any of the
-- existing pipeline tables.
CREATE TABLE admin_section_views (
  section TEXT PRIMARY KEY,
  last_viewed_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);
