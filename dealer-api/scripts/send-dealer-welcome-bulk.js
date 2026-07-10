// One-time script: sends the "Dealer Welcome" Brevo template (id 7, the same
// template wired into dealer-api/src/index.js's dealerSignup flow) to every
// existing dealer already in the D1 `dealers` table, personalized per dealer.
//
// SAFETY: this script defaults to a DRY RUN — it only prints what it would
// send. Nothing is emailed until you pass --send explicitly.
//
// Usage:
//   node scripts/send-dealer-welcome-bulk.js                 (dry run, all dealers)
//   node scripts/send-dealer-welcome-bulk.js --send           (actually sends)
//   node scripts/send-dealer-welcome-bulk.js --send --limit=1 (send to just the first dealer, sanity check)
//   node scripts/send-dealer-welcome-bulk.js --include-admins (also emails role='admin' rows, e.g. Jeff's own account)
//
// Requires BREVO_API_KEY in the environment (the same secret set on the
// deployed Worker via `wrangler secret put BREVO_API_KEY`), and requires you
// to already be authenticated with `wrangler` (it shells out to
// `wrangler d1 execute` to read the live dealer list).

const { execSync } = require('child_process');

const DEALER_WELCOME_TEMPLATE_ID = 7;
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--send');
const includeAdmins = args.includes('--include-admins');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

function fetchDealers() {
  const raw = execSync(
    `npx wrangler d1 execute dealer-portal --remote --json --command "SELECT id, name, email, role FROM dealers ORDER BY id"`,
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const parsed = JSON.parse(raw);
  return parsed[0].results;
}

async function sendWelcomeEmail(apiKey, dealer, firstName) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      to: [{ email: dealer.email }],
      templateId: DEALER_WELCOME_TEMPLATE_ID,
      params: { FIRSTNAME: firstName },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo rejected send for ${dealer.email}: ${res.status} ${body}`);
  }
}

async function main() {
  if (!DRY_RUN && !process.env.BREVO_API_KEY) {
    console.error('BREVO_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  console.log(`Fetching dealers from D1 (remote)...`);
  let dealers = fetchDealers();

  if (!includeAdmins) {
    dealers = dealers.filter(d => d.role !== 'admin');
  }
  if (limit) {
    dealers = dealers.slice(0, limit);
  }

  console.log(`${dealers.length} dealer(s) will be ${DRY_RUN ? 'previewed (dry run)' : 'emailed'}:\n`);

  for (const dealer of dealers) {
    const firstName = (dealer.name || '').trim().split(/\s+/)[0] || 'there';
    console.log(`  #${dealer.id}  ${dealer.email}  -> FIRSTNAME="${firstName}"`);
  }

  if (DRY_RUN) {
    console.log('\nDry run only — no emails were sent. Re-run with --send to actually send.');
    return;
  }

  console.log('\nSending...');
  for (const dealer of dealers) {
    const firstName = (dealer.name || '').trim().split(/\s+/)[0] || 'there';
    try {
      await sendWelcomeEmail(process.env.BREVO_API_KEY, dealer, firstName);
      console.log(`  sent -> ${dealer.email}`);
    } catch (err) {
      console.error(`  FAILED -> ${dealer.email}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log('\nDone.');
}

main();
