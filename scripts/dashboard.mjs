// Builds the traffic dashboard as a local HTML file (the live version is the password-protected /admin page).
//
//   npm run dashboard                    last 7 days, writes dist/dashboard.html
//   npm run dashboard -- --days 30       up to 90 days
//   npm run dashboard -- --sample        fake numbers, no token needed, to preview the layout
//
// Needs CLOUDFLARE_API_TOKEN (Account > Account Analytics > Read) in the environment or in .env.dashboard (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { buildReport, loadRaw, MAX_DAYS, renderHtml, sampleRaw } from '../src/dashboard.ts';

const DEFAULT_ACCOUNT = '23ead300fd2e0d517e1bf18ee449d0c1';
const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(value('--days', '7'), 10) || 7));
const out = value('--out', 'dist/dashboard.html');
const sample = args.includes('--sample');

const readEnvFile = (file) => (fs.existsSync(file)
  ? Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
  : {});

let raw;
if (sample) {
  raw = sampleRaw(days);
} else {
  const env = { ...readEnvFile('.env.dashboard'), ...process.env };
  if (!env.CLOUDFLARE_API_TOKEN) {
    console.error('Set CLOUDFLARE_API_TOKEN (Account > Account Analytics > Read) in the environment or in .env.dashboard.\nTo preview the layout without a token, run: npm run dashboard -- --sample');
    process.exit(1);
  }
  raw = await loadRaw(days, { accountId: env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT, token: env.CLOUDFLARE_API_TOKEN });
}
const report = buildReport(raw, days);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, renderHtml(report, { sample }));
console.log(`wrote ${out}: ${report.total} requests${report.unavailable.length ? `, ${report.unavailable.length} panel(s) unavailable` : ''}`);
