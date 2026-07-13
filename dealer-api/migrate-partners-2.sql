-- Follow-up to migrate-partners.sql: rate limiting for the public
-- application form, and the approve-before-send queue for the AI-generated
-- lifecycle email engine (Section 12 — "Approve-before-send: ON at launch").

CREATE TABLE partner_apply_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_partner_apply_attempts_ip_created ON partner_apply_attempts(ip, created_at);

ALTER TABLE partners ADD COLUMN signup_ip TEXT;

CREATE TABLE partner_lifecycle_email_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_lead_id INTEGER NOT NULL REFERENCES partner_leads(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,   -- test_drive_prep | test_drive_followup | still_shopping | won | lost
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  white_glove INTEGER NOT NULL DEFAULT 0,   -- every template except 'won'
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | sent | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  sent_at TEXT
);
CREATE INDEX idx_partner_lifecycle_email_queue_status ON partner_lifecycle_email_queue(status);
