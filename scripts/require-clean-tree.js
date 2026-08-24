#!/usr/bin/env node
// Blocks `wrangler deploy` when the working tree has uncommitted changes.
//
// This exists because /referral (and likely /guides, universal search)
// repeatedly vanished from production: they were added as local files and
// shipped with a direct `wrangler deploy`, but never committed. The next
// deploy from any *other* checkout — a fresh clone, a different session,
// the same folder after the untracked file was lost — silently re-uploaded
// whatever was on disk there, which never had the fix, wiping it out again.
// `wrangler deploy` uploads local disk state wholesale with no awareness
// that it might be regressing something. This is the cheapest way to make
// that specific failure mode impossible: git status must be clean before a
// deploy is allowed to run.
const { execSync } = require('child_process');

const status = execSync('git status --porcelain', { cwd: __dirname + '/..' }).toString();

if (status.trim()) {
  console.error('\n✖ Refusing to deploy: working tree has uncommitted changes.\n');
  console.error(status);
  console.error(
    'Commit (and ideally push) before deploying — an uncommitted file that gets ' +
    'deployed today is gone the next time anyone deploys from a clean checkout.\n'
  );
  process.exit(1);
}
