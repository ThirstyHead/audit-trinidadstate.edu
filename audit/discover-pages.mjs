/**
 * Page-scope discovery for the configured college (see college.json at repo root).
 *
 * One-time curation AID — not part of the CI pipeline. Crawls the college
 * homepage, resolves every <a href>, keeps only the in-scope host, drops
 * non-HTML assets and JS template placeholders, dedupes /x/ vs /x/index.html,
 * then VERIFIES each candidate returns HTTP 200 before writing it out — so
 * `pages.json` only ever lists live pages.
 *
 * Usage:
 *   node audit/discover-pages.mjs [--out audit/pages.json] [--host <host>]
 *                                  [--concurrency 5] [--limit 100]
 *
 *   --out           Where to write the generated pages.json (default:
 *                    audit/pages.json.candidates — never overwrites the
 *                    curated pages.json without --force).
 *   --host          Exact host to keep (www stripped). Default: college.json
 *                    domain. Pass deliberately to broaden/narrow scope.
 *   --concurrency   Parallel 200-checks (default 5; keep low — be polite).
 *   --limit         Stop after N verified pages (default: none).
 *   --force         Overwrite an existing audit/pages.json when --out points
 *                    at it.
 *
 * The output is a candidate list for a HUMAN to review and trim (top-level
 * nav + key sections; drop login-walled or mega-sections). Commit the
 * reviewed file as audit/pages.json.
 *
 * Uses a real browser UA for probes so WAFs treat us as a normal visitor.
 */
import fs from 'node:fs';
import config from './config.mjs';

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
function flag(name) {
  return argv.includes(`--${name}`);
}

const OUT = arg('out', 'audit/pages.json.candidates');
const CONC = Number(arg('concurrency', '5'));
const LIMIT = arg('limit', null) ? Number(arg('limit')) : Infinity;
const FORCE = flag('force');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const domain = config.domain;
const keepHost = arg('host', domain).toLowerCase().replace(/^www\./, '');
const base = `${config.baseUrl}/`;
const seed = new URL(base);

const NON_HTML = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|mp4|webm|mp3|wav|zip|rar|docx?|xlsx?|pptx?|txt|xml|rss|atom)(\?|$)/i;
// CMS/JS template placeholders that appear as hrefs in server-rendered HTML.
const isPlaceholder = (p) => /(%7B|%7D|\{%=|o\.guid|o\[i\]|o\[i\]\.updates)/.test(p);

function normHost(h) {
  return h.toLowerCase().replace(/^www\./, '');
}
// /x/ and /x/index.html are the same page -> collapse to the shorter /x/.
function canon(path) {
  if (/\/index\.html$/i.test(path)) return path.replace(/index\.html$/i, '');
  return path;
}

console.error(`seed: ${base} (host scope: ${keepHost})`);
const html = await (
  await fetch(base, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'user-agent': UA } })
).text();

const hrefs = [...html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);

const seen = new Map(); // canonKey -> full URL to verify
for (const raw of hrefs) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    continue;
  }
  if (!['http:', 'https:'].includes(u.protocol)) continue; // skip tel:, mailto:, javascript:, #
  if (normHost(u.hostname) !== keepHost) continue; // in-scope host only
  if (NON_HTML.test(u.pathname)) continue; // no assets
  if (isPlaceholder(u.pathname)) continue; // no JS template junk
  const key = canon(u.pathname);
  if (!seen.has(key)) seen.set(key, u.toString());
}

let candidates = [...seen.keys()].sort((a, b) => a.localeCompare(b));
console.error(`candidates after filter+dedupe: ${candidates.length}`);

// Verify each at its CORRECT resolved URL (not base+path, which double-slashes).
async function check(fullUrl, p) {
  try {
    const res = await fetch(fullUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
      headers: { 'user-agent': UA },
    });
    const status = res.status;
    res.body?.cancel?.();
    const finalUrl = new URL(res.url);
    // Keep the post-redirect canonical path only if it stayed on the in-scope host.
    const fp = normHost(finalUrl.hostname) === keepHost ? canon(finalUrl.pathname) : canon(p);
    return { p, status, final: fp };
  } catch (e) {
    return { p, status: 0, final: null, err: String(e) };
  }
}

const results = [];
for (let i = 0; i < candidates.length; i += CONC) {
  results.push(...(await Promise.all(candidates.slice(i, i + CONC).map((p) => check(seen.get(p), p)))));
}

const ok = results.filter((r) => r.status === 200);
const bad = results.filter((r) => r.status !== 200);
const finals = new Map();
for (const r of ok) {
  if (!finals.has(r.final)) finals.set(r.final, true);
  if (finals.size >= LIMIT) break;
}
const finalPaths = [...finals.keys()].sort((a, b) => a.localeCompare(b));

if (OUT === 'audit/pages.json' && fs.existsSync('audit/pages.json') && !FORCE) {
  console.error('refusing to overwrite curated audit/pages.json without --force');
  process.exit(1);
}

const doc = { baseUrl: config.baseUrl, pages: finalPaths };
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');

console.error(`\nverified 200 (unique canonical): ${finalPaths.length} -> ${OUT}`);
for (const r of bad) console.error(`  DROP ${r.status}  ${r.p}${r.err ? ` (${r.err})` : ''}`);
console.error('\nNext: review the list (keep top-level nav + key sections), then commit as audit/pages.json.');