# Dealer / Admin Password Reset

Self-service password reset for the Dealer Portal. There's no separate admin
account type — **an admin is a `dealers` row with `role = 'admin'`** (Jeff's
account included), so this one flow covers both regular dealers and admins.
No account, admin or otherwise, can get permanently locked out as long as
either Brevo delivery works or you can run the emergency script below.

## Normal flow

1. **Request** — `POST /api/dealer/password-reset/request` `{ email }`
   (`view-forgot-password` in `Dealerportal.html`, reachable via "Forgot
   password?" on the login card).
   - Always responds `{ success: true }` regardless of whether the email has
     an account — the response never reveals whether an address is
     registered.
   - Rate-limited to 3 requests/email/hour via the `password_reset_attempts`
     table (a 429 is the one case the frontend does surface distinctly, since
     it isn't an enumeration risk).
   - Generates a 32-byte random token, stores only `SHA-256(token)` in
     `dealer_password_resets` (the raw token is never persisted — it exists
     only in memory and in the one email that gets sent), and invalidates any
     prior unused token for that dealer.
   - Emails a link to `Dealerportal.html?reset=<token>`, valid 30 minutes.
   - Logs a `password_reset_requested` row to `admin_audit_log`.

2. **Confirm** — `POST /api/dealer/password-reset/confirm` `{ token, password }`
   (`view-reset-password`, opened automatically when the page loads with a
   `?reset=` query param).
   - Requires 12+ characters and rejects a small list of common weak
     passwords with an OK-looking length (`COMMON_PASSWORD_BLOCKLIST` in
     `src/index.js`).
   - Looks the token up by hash, rejects if expired or already used.
   - Re-hashes the password with the same PBKDF2 scheme (`hashPassword`,
     100k iterations, per-account salt) every other password in this system
     uses — no new hashing scheme introduced for this feature.
   - Marks the token used, invalidates any other outstanding token for that
     dealer, and **deletes every `dealer_sessions` row for that dealer** —
     a password reset force-logs-out any existing session, including an
     attacker's.
   - Logs a `password_reset_completed` row to `admin_audit_log`.

## Emergency fallback (Brevo down, or the recovery inbox is itself lost)

`scripts/emergency-password-reset.js` generates a reset link the same way
the API does — same table, same hashing, redeemed by the same `/confirm`
endpoint — but talks to D1 directly via `wrangler d1 execute --remote`
instead of going through the Worker or Brevo. Use it when email delivery
itself is the problem.

```
node scripts/emergency-password-reset.js jeff@theexactmatch.com
```

Requires `wrangler` to be authenticated locally (same requirement as
`scripts/send-dealer-welcome-bulk.js`). Prints a reset link good for 30
minutes — hand it to the account owner through a channel other than email
(text, in person, etc.), since email being unavailable is presumably why
you're running this. Every run is logged to `admin_audit_log` as
`emergency_reset_generated`, including the OS username that ran it.

## Migration

`migrate-password-reset-hardening.sql` — recreates `dealer_password_resets`
around a hashed token instead of the raw token the original build stored,
and adds `password_reset_attempts` (rate limiting) and `admin_audit_log`
(audit trail for both the normal and emergency paths). Apply with:

```
npx wrangler d1 execute dealer-portal --remote --file=migrate-password-reset-hardening.sql
```
