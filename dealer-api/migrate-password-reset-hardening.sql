-- Hardens the dealer/admin password-reset flow added in
-- migrate-merge-dealers-partners.sql. That version stored the raw reset
-- token as dealer_password_resets' primary key — anyone with read access to
-- D1 (a backup, a future export, a bug in an unrelated admin query) could
-- use it directly to take over any account, including Jeff's admin login.
-- This recreates the table keyed on a SHA-256 hash of the token instead —
-- the raw token is never persisted anywhere — and adds the rate limiting
-- and audit logging the original build skipped.
--
-- No data-preserving copy needed: every row is a single-use token with a
-- short TTL (was 2h, now 30m per src/index.js). Anything outstanding right
-- now just expires a little early — harmless.

DROP TABLE dealer_password_resets;

CREATE TABLE dealer_password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_dealer_password_resets_dealer_id ON dealer_password_resets(dealer_id);

-- Per-email + per-IP rate limiting for /api/dealer/password-reset/request.
-- Same shape as partner_apply_attempts (migrate-partners.sql).
CREATE TABLE password_reset_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_password_reset_attempts_email ON password_reset_attempts(email);
CREATE INDEX idx_password_reset_attempts_created_at ON password_reset_attempts(created_at);

-- General admin-visibility audit trail. Starts with password-reset events
-- (request / confirm / emergency-CLI-generated) but the shape is generic
-- enough to log other sensitive admin actions later without another migration.
CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  dealer_id INTEGER REFERENCES dealers(id) ON DELETE SET NULL,
  dealer_email TEXT,
  ip TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_audit_log_dealer_id ON admin_audit_log(dealer_id);
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);
