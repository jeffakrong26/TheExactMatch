// Emergency fallback for the "forgot password" flow in src/index.js.
//
// Normal path: POST /api/dealer/password-reset/request generates a token and
// emails it via Brevo. This script exists for when that path doesn't work —
// Brevo delivery fails, DNS/inbox issues swallow the email, or the account
// that would receive the recovery email (e.g. Jeff's own inbox) is itself
// inaccessible. It talks to D1 directly via `wrangler d1 execute --remote`,
// the same way scripts/send-dealer-welcome-bulk.js does, so it works even if
// the Worker or Brevo are both down — the only dependency is `wrangler`
// being authenticated locally.
//
// It reuses the exact same table (dealer_password_resets) and hashing
// scheme (SHA-256 of the token, never the raw token) as the normal flow, so
// the link it prints is redeemed by the existing
// POST /api/dealer/password-reset/confirm endpoint — no separate code path
// to keep in sync.
//
// Usage:
//   node scripts/emergency-password-reset.js jeff@theexactmatch.com
//
// Prints a reset link good for 30 minutes. Hand it to the account owner
// through some channel other than the email that's presumably the problem
// (text message, in person, etc).

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;
const RESET_BASE_URL = 'https://theexactmatch.com/Dealerportal.html';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/emergency-password-reset.js <email>');
  process.exit(1);
}

function sqlEscape(str) {
  return str.replace(/'/g, "''");
}

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `tem-emergency-reset-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    const raw = execSync(
      `npx wrangler d1 execute dealer-portal --remote --json --file="${tmpFile}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(raw);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function randomTokenBase64Url(byteLen) {
  return crypto.randomBytes(byteLen).toString('base64url');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function main() {
  console.log(`Looking up ${email} in dealer-portal (remote)...`);
  const lookup = runSql(`SELECT id, name, email FROM dealers WHERE email = '${sqlEscape(email)}';`);
  const dealer = lookup[0]?.results?.[0];
  if (!dealer) {
    console.error(`No dealer/admin account found for ${email}. Nothing generated.`);
    process.exit(1);
  }

  const token     = randomTokenBase64Url(32);
  const tokenHash = sha256Hex(token);
  const runBy     = os.userInfo().username || 'unknown';

  // Invalidate any prior outstanding tokens, insert the new one, and record
  // this generation in the audit log — same invariants the normal
  // POST /api/dealer/password-reset/request endpoint enforces.
  const sql = `
UPDATE dealer_password_resets SET used_at = datetime('now') WHERE dealer_id = ${dealer.id} AND used_at IS NULL;
INSERT INTO dealer_password_resets (dealer_id, token_hash, expires_at)
  VALUES (${dealer.id}, '${tokenHash}', datetime('now', '+${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes'));
INSERT INTO admin_audit_log (event, dealer_id, dealer_email, detail)
  VALUES ('emergency_reset_generated', ${dealer.id}, '${sqlEscape(dealer.email)}', 'generated locally via emergency-password-reset.js by OS user "${sqlEscape(runBy)}"');
`;
  runSql(sql);

  const url = `${RESET_BASE_URL}?reset=${encodeURIComponent(token)}`;
  console.log(`\nReset link for ${dealer.name} <${dealer.email}> (expires in ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes):\n`);
  console.log(`  ${url}\n`);
  console.log('Deliver this through a channel other than email if email is the reason you\'re running this script.');
}

main();
