#!/usr/bin/env node
// Renders scripts/lead-magnet/dealer-email-scripts.html to
// downloads/dealer-email-scripts.pdf with headless Chromium.
//
// The PDF is committed (it's what the welcome email attaches), so this only
// needs re-running when the source HTML changes. Requires Playwright, which
// isn't a project dependency — run with a global install, e.g.:
//   npx -y playwright@1 --version >/dev/null && node scripts/lead-magnet/build-pdf.js
// Set CHROMIUM_PATH to use an existing Chromium instead of Playwright's own.
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..', '..');
const src = path.join(__dirname, 'dealer-email-scripts.html');
const out = path.join(root, 'downloads', 'dealer-email-scripts.pdf');

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  await page.goto(`file://${src}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: out,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    // Footer on every page. Header/footer templates render in their own
    // context with no page CSS or web fonts, hence the inline styles.
    footerTemplate: `<div style="width:100%;margin:0 0.55in;padding-top:5px;border-top:1px solid #e2dacb;font-family:sans-serif;font-size:7.5pt;color:#6b6b6b;display:flex;justify-content:space-between">
      <span><b style="color:#0f1f35">The Exact Match</b> — We don't list cars. We find yours.</span><span>theexactmatch.com</span></div>`,
  });
  await browser.close();
  console.log(`Wrote ${path.relative(root, out)}`);
})();
