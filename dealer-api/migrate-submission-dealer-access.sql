-- 'selected' visibility on inventory_submissions.visibility: admin pushes a
-- vehicle to specific dealer partners instead of all dealers ('network') or
-- nobody ('private'). This table holds the per-dealer allowlist for those
-- submissions. See adminCreateSubmission/adminUpdateSubmission/
-- networkInventory in src/index.js.
CREATE TABLE submission_dealer_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES inventory_submissions(id) ON DELETE CASCADE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(submission_id, dealer_id)
);
