-- Free Deal Review (/review-my-deal): one row per submitted deal.
-- Lifecycle: pending (draft generated, awaiting a team member) -> sent
-- (approved and emailed) or rejected. Nothing reaches the visitor until a
-- team member approves it in the admin "Deal Reviews" tab.
--
-- deal_json   normalized deal (src/deal-review.js normalizeDeal)
-- draft_json  editable report draft: { verdict_key, verdict_basis, flags,
--             sections: { <key>: { body, needsInput } } }
-- photo_key   R2 key of the buyer's-order photo (photo path only). Served
--             to admin only, never publicly — a buyer's order can carry an
--             address and a driver's license number.
CREATE TABLE deal_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  state TEXT,
  newsletter_opt_in INTEGER NOT NULL DEFAULT 0,
  newsletter_added INTEGER NOT NULL DEFAULT 0,
  deal_json TEXT NOT NULL,
  draft_json TEXT,
  draft_error TEXT,
  photo_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  rejected_at TEXT
);
CREATE INDEX idx_deal_reviews_status ON deal_reviews (status, created_at);

-- Buyer's-order photos uploaded on the photo path before the visitor has
-- submitted (the upload happens first, then they verify the extracted
-- fields). Claimed by the submission via its token; unclaimed rows and
-- their R2 objects are swept by the daily cleanup after 2 days.
CREATE TABLE deal_review_uploads (
  token TEXT PRIMARY KEY,
  photo_key TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deal_review_uploads_ip ON deal_review_uploads (ip_hash, created_at);
