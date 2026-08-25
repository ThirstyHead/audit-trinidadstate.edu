/**
 * Build the public GitHub Pages site from audit report JSON.
 *
 * Zero dependencies (node only). Part of the weekly publishing pipeline:
 * GitHub Actions runs the audit (audit/axe-audit.mjs), then runs this
 * script to render a static site into the results repo's docs/ folder,
 * which GitHub Pages serves.
 *
 * Usage:
 *   node site/build-site.mjs --report <latest.json> --history-dir <dir> --out <docsDir>
 *   node site/build-site.mjs --latest --history-dir <dir> --out <docsDir>
 *
 * If the report's directory contains pages/ (per-page HTML reports from
 * axe-html-reporter) and/or raw/ (per-page raw results), they are copied
 * into <docsDir> so the index can link to them.
 *
 * Options:
 *   --report <path>      Path to the latest raw report JSON (axe-*.json)
 *   --latest             Auto-pick the newest axe-*.json in --history-dir
 *   --history-dir <dir>  Directory containing all raw report JSON files
 *   --out <dir>          Output directory for the static site (default: site/dist)
 *   --raw-base <url>     Base URL for linking to raw report files
 *   --site-name <name>   Human name of the audited site
 *   --site-url <url>     Canonical URL of the audited site
 *
 * Outputs (in --out):
 *   index.html    Human-facing report page
 *   latest.json   Latest raw report + metadata
 *   history.json  Time series across all runs (for trends)
 *   pages/        Per-page standalone HTML reports (axe-html-reporter),
 *                 copied from the report dir when present
 *   raw/          Per-page raw axe results JSON, copied when present
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import config from '../audit/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_REPO = config.toolsRepoUrl;

const SEVERITY_META = [
  ['critical', '#b03a2e', 'Critical'],
  ['serious', '#ca6f1e', 'Serious'],
  ['moderate', '#b7950b', 'Moderate'],
  ['minor', '#707b7c', 'Minor'],
];

// ---------- args ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

function loadReport(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// in-page `incomplete` was an array in newer audit runs but a plain number in
// older report generations — normalize to a node count for the summary.
function incompleteNodes(p) {
  const inc = p.incomplete;
  if (Array.isArray(inc)) return inc.reduce((n, v) => n + (v.nodes || 0), 0);
  if (typeof inc === 'number') return inc;
  return 0;
}

function summarizeReport(report, reportFile) {
  const pages = report.pages || [];
  const blocked = pages.filter((p) => p.blocked || (typeof p.status === 'number' && p.status >= 400));
  const failed = pages.filter((p) => p.error && !blocked.includes(p));
  const ok = pages.filter((p) => !p.error);
  const bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let total = 0;
  let needsReview = 0;
  for (const p of ok) {
    total += p.violationTotal || 0;
    needsReview += incompleteNodes(p);
    for (const v of p.violations || []) {
      if (v.impact && v.impact in bySeverity) bySeverity[v.impact] += v.nodes || 0;
    }
  }
  return {
    generated: report.generated,
    reportFile,
    pagesAudited: ok.length,
    pagesFailed: failed.length,
    pagesBlocked: blocked.length,
    cleanPages: ok.filter((p) => (p.violationTotal || 0) === 0).length,
    totalViolations: total,
    bySeverity,
    needsReview,
  };
}

function loadHistory(dir, latestFile) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^axe-.*\.json$/.test(f))
    .sort();
  return files.map((f) => summarizeReport(loadReport(path.join(dir, f)), f));
}

// ---------- html pieces ----------

function sparkline(series) {
  if (series.length < 2) return null;
  const w = 680, h = 150, padX = 40, padT = 18, padB = 30;
  const vals = series.map((p) => p.totalViolations);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const x = (i) => padX + (i * (w - 2 * padX)) / (series.length - 1);
  const y = (v) => h - padB - ((v - min) / range) * (h - padT - padB);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.totalViolations).toFixed(1)}`).join(' ');
  const dots = series
    .map(
      (p, i) =>
        `<circle cx="${x(i).toFixed(1)}" cy="${y(p.totalViolations).toFixed(1)}" r="4" fill="#2c3e50">
         <title>${esc(p.generated)} — ${p.totalViolations} node-level violations</title>
       </circle>`,
    )
    .join('\n');
  const d0 = esc(series[0].generated.slice(0, 10));
  const dN = esc(series[series.length - 1].generated.slice(0, 10));
  return `
    <svg viewBox="0 0 ${w} ${h}" class="spark" role="img" aria-label="Trend of total node-level violations across audit runs">
      <polyline points="${pts}" fill="none" stroke="#2c3e50" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <text x="${padX}" y="${h - 8}" class="axis">${d0}</text>
      <text x="${w - padX}" y="${h - 8}" class="axis" text-anchor="end">${dN}</text>
      <text x="${x(series.length - 1) + 8}" y="${y(vals[vals.length - 1]) + 4}" class="axis">${vals[vals.length - 1]}</text>
    </svg>`;
}

// Top-level listing: every page tested, with a link to its individual
// axe-html-reporter audit page when the report carries a pagesHtml map
// (runs produced by audit/axe-audit.mjs with per-page output).
function pagesTable(report) {
  const pages = report.pages || [];
  const hasReports = !!(report.pagesHtml && Object.keys(report.pagesHtml).length);
  const rows = pages.map((p) => {
    const isBlocked = p.blocked || (typeof p.status === 'number' && p.status >= 400);
    if (isBlocked) {
      return `    <tr class="caveat">
      <td class="pg"><span class="caveat-err">${esc(p.url)} — <em>not audited: HTTP ${p.status} (WAF/404), excluded from results</em></span></td>
      <td class="n">—</td><td class="n">—</td><td></td>
    </tr>`;
    }
    if (p.error) {
      return `    <tr>
      <td class="pg"><span class="err">${esc(p.url)} — <em>failed: ${esc(String(p.error).slice(0, 160))}</em></span></td>
      <td class="n">—</td><td class="n">—</td><td></td>
    </tr>`;
    }
    const vio = p.violationTotal || 0;
    const inc = incompleteNodes(p);
    const rep = hasReports && report.pagesHtml[p.url] ? report.pagesHtml[p.url] : null;
    return `    <tr${vio ? ' class="bad"' : ''}>
      <td class="pg"><a href="${esc(p.url)}" rel="noopener">${esc(p.title || p.url)}</a>${p.title ? ` <span class="pwurl">${esc(p.url)}</span>` : ''}</td>
      <td class="n${vio ? ' bad' : ''}">${vio || '0'}</td>
      <td class="n">${inc}</td>
      <td class="links">${rep ? `<a class="pgrep" href="${esc(rep)}">Audit report</a>` : ''}</td>
    </tr>`;
  });
  return `
<table class="pages">
  <thead><tr><th class="pg">Page</th><th class="n">Violations</th><th class="n">Needs review</th><th>Report</th></tr></thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`;
}

function coverageCaveats(report) {
  const pages = report.pages || [];
  const blocked = pages.filter((p) => p.blocked || (typeof p.status === 'number' && p.status >= 400));
  if (!blocked.length) return '';
  const rows = blocked.map((p) => `
    <tr><td class="pg"><a href="${esc(p.url)}" rel="noopener">${esc(p.url)}</a></td>
      <td class="n"><span class="caveat-badge">HTTP ${esc(p.status)}</span></td>
      <td class="count">Not audited — the page returned an HTTP error (often a WAF or 404) instead of real content, so it is excluded from the results above.</td></tr>`).join('');
  return `
<h2>Coverage caveats (${blocked.length} not audited)</h2>
<p class="note">These pages returned an HTTP error during the run, so axe could not analyze real content. They are excluded from the violation counts above. A 403 usually means the site's WAF blocked the audit's IP; a 404 means the page may have moved or the link is stale.</p>
<table class="pages">
  <thead><tr><th class="pg">Page</th><th class="n">HTTP</th><th>Why</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function renderSite({ latest, history, args, report }) {
  const siteName = args['site-name'] || config.siteName;
  const siteUrl = args['site-url'] || config.baseUrl;
  const rawBase =
    args['raw-base'] || `${config.resultsRepoUrl}/blob/main/reports`;

  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const delta = prev ? latest.totalViolations - prev.totalViolations : null;
  const deltaHtml =
    delta === null
      ? '<span class="delta first">first published run</span>'
      : delta === 0
        ? '<span class="delta flat">no change vs last run</span>'
        : delta < 0
          ? `<span class="delta down">▼ ${-delta} vs last run</span>`
          : `<span class="delta up">▲ ${delta} vs last run</span>`;

  const sevCards = SEVERITY_META.map(
    ([sev, color, label]) => `
      <div class="sevcard" style="border-top:4px solid ${color}">
        <span class="num">${latest.bySeverity[sev]}</span>
        <span class="lbl">${label}</span>
      </div>`,
  ).join('');

  const svg = sparkline(history);
  const latestIso = latest.generated;
  const latestDate = new Date(latestIso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WCAG 2.1 AA Audit — ${esc(siteName)} (${esc(siteUrl)})</title>
<meta name="description" content="Automated weekly WCAG 2.1 AA accessibility audit results for ${esc(siteUrl)}, produced with axe-core.">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 940px;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #212f3c; background: #fdfdfc;
  }
  header h1 { font-size: 1.7rem; margin: 0 0 .25rem; }
  header .sub { color: #566573; margin: 0 0 1rem; }
  .meta { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; color: #566573; font-size: .92rem; border-bottom: 1px solid #e3e7ea; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
  .card { background: #fff; border: 1px solid #e3e7ea; border-radius: 8px; padding: .9rem 1rem; }
  .card .num { display: block; font-size: 1.9rem; font-weight: 700; line-height: 1.2; }
  .card .lbl { color: #566573; font-size: .85rem; }
  .sevcard { background: #fff; border: 1px solid #e3e7ea; border-radius: 8px; padding: .6rem .8rem; display: flex; align-items: baseline; gap: .5rem; }
  .sevcard .num { font-size: 1.4rem; font-weight: 700; }
  .sevcard .lbl { color: #566573; font-size: .82rem; }
  .severities { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .5rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .spark { width: 100%; max-width: 680px; height: auto; background: #fff; border: 1px solid #e3e7ea; border-radius: 8px; }
  .axis { font-size: 11px; fill: #7b8a8b; }
  .delta { font-size: .9rem; font-weight: 600; }
  .delta.up { color: #b03a2e; } .delta.down { color: #1e8449; }
  .delta.flat, .delta.first { color: #7b8a8b; font-weight: 400; }
  .page { background: #fff; border: 1px solid #e3e7ea; border-radius: 8px; padding: 1rem 1.25rem 1.25rem; margin-bottom: 1rem; }
  .page.failed { border-color: #f0b27a; background: #fef9f3; }
  .page h3 { margin: 0 0 .25rem; font-size: 1.05rem; word-break: break-all; }
  .page h3 .title { font-weight: 400; color: #7b8a8b; font-size: .9rem; }
  .page h4 { margin: 1rem 0 .5rem; font-size: .95rem; }
  .count { color: #7b8a8b; font-weight: 400; font-size: .85rem; }
  .total { margin: 0 0 .5rem; color: #566573; }
  .clean { color: #1e8449; font-weight: 600; }
  .warn { color: #b9770e; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #eef1f2; vertical-align: top; }
  th { color: #566573; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  .targets { color: #7b8a8b; font-size: .82rem; word-break: break-all; max-width: 260px; }
  code { background: #f4f6f7; padding: .1rem .35rem; border-radius: 4px; font-size: .85em; }
  ul.inc { margin: .25rem 0 0; padding-left: 1.2rem; }
  .note { color: #566573; font-size: .9rem; margin: .25rem 0 .75rem; }
  table.pages { width: 100%; border-collapse: collapse; font-size: .9rem; }
  table.pages thead th {
    position: sticky; top: 0; background: #fdfdfc; z-index: 1;
    border-bottom: 2px solid #e3e7ea;
  }
  table.pages th.n, table.pages td.n { text-align: right; white-space: nowrap; }
  table.pages td.n.bad { color: #b03a2e; font-weight: 700; }
  table.pages td.pg { max-width: 0; }
  table.pages td.pg a { word-break: break-all; }
  table.pages .pwurl { display: block; color: #7b8a8b; font-size: .8rem; margin-top: .1rem; word-break: break-all; }
  table.pages td.pg .err { word-break: break-all; }
  table.pages td.links { white-space: nowrap; text-align: right; }
  table.pages a.pgrep {
    color: #2e86c1; text-decoration: none; font-weight: 600;
    border: 1px solid #cfe6f5; background: #f4fafd; padding: .15rem .5rem; border-radius: 6px;
  }
  table.pages a.pgrep:hover { background: #e8f4fb; }
  table.pages tr.bad td.pg a { color: #b03a2e; }
  footer { margin-top: 2.5rem; border-top: 1px solid #e3e7ea; padding-top: 1rem; font-size: .85rem; color: #566573; }
  footer a { color: #2e86c1; }
  .datamenu { display: flex; flex-wrap: wrap; gap: 1rem; margin: .5rem 0; }
  table.pages tr.caveat td.pg .caveat-err { color: #b9770e; word-break: break-all; }
  .caveat-badge { background: #fef9f3; color: #b9770e; border: 1px solid #f0b27a; padding: .1rem .4rem; border-radius: 4px; font-weight: 600; white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>WCAG 2.1 AA Audit — ${esc(siteName)}</h1>
  <p class="sub"><a href="${esc(siteUrl)}">${esc(siteUrl)}</a></p>
</header>

<div class="meta">
  <span>Last audited: <strong>${latestDate}</strong> (UTC)</span>
  <span>Published runs: ${history.length}</span>
  <span>Tooling: <a href="${TOOLS_REPO}">axe-core + Playwright</a>, run weekly via GitHub Actions</span>
  <span>${deltaHtml}</span>
</div>

<h2>Latest results</h2>
<div class="cards">
  <div class="card"><span class="num">${latest.totalViolations}</span><span class="lbl">Node-level violations</span></div>
  <div class="card"><span class="num">${latest.pagesAudited}</span><span class="lbl">Pages audited</span></div>
  <div class="card"><span class="num">${latest.needsReview}</span><span class="lbl">Need manual review</span></div>
  <div class="card"><span class="num ${latest.pagesBlocked ? 'warn' : ''}">${latest.pagesBlocked ?? 0}</span><span class="lbl">Not audited (HTTP error)</span></div>
</div>
<div class="severities">${sevCards}</div>

<h2>Trend</h2>
${svg ? `<div>${svg}</div>` : '<p class="count">The trend chart appears once at least two runs have been published.</p>'}

<h2>Pages</h2>
<p class="note">Every page audited in this run. “Audit report” opens that page's full axe report — violations, needs-review, and passes, with node-level detail.</p>
${pagesTable(report)}
${coverageCaveats(report)}

<h2>Data</h2>
<div class="datamenu">
  <a href="latest.json">latest.json</a>
  <a href="history.json">history.json</a>
  <a href="${esc(rawBase)}/${esc(latest.reportFile)}">Raw report (latest)</a>
  <a href="${esc(config.resultsRepoUrl)}/tree/main/reports">All raw reports</a>
</div>

<footer>
  <p><strong>About this audit.</strong> Results are produced automatically by
  <a href="https://github.com/dequelabs/axe-core">axe-core</a> (Deque) against the WCAG 2.1 A/AA rule set,
  on a weekly schedule, by the open-source tooling in
  <a href="${TOOLS_REPO}">${TOOLS_REPO.replace('https://github.com/', '')}</a>.
  Automated tooling detects only a subset of accessibility failures and does not replace
  manual or assistive-technology testing. “Needs manual review” items are results axe
  could not determine automatically.</p>
  <p>Generated ${esc(new Date().toISOString())} · <a href="${esc(config.canonicalSiteUrl)}">${esc(config.canonicalSiteUrl.replace(/^https?:\/\//, ''))}</a></p>
</footer>
</body>
</html>`;
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
if (!args['history-dir'] || !args.report && !args.latest) {
  console.error('Usage: node site/build-site.mjs (--report <path> | --latest) --history-dir <dir> [--out <dir>] [--pages-dir <dir>] [--raw-base <url>] [--site-name <name>] [--site-url <url>]');
  process.exit(2);
}

const historyDir = path.resolve(args['history-dir']);
if (!fs.existsSync(historyDir)) {
  console.error(`history-dir not found: ${historyDir}`);
  process.exit(2);
}

let reportPath;
if (args.latest) {
  const files = fs.readdirSync(historyDir).filter((f) => /^axe-.*\.json$/.test(f)).sort();
  if (!files.length) {
    console.error(`No axe-*.json reports in ${historyDir}`);
    process.exit(2);
  }
  reportPath = path.join(historyDir, files[files.length - 1]);
} else {
  reportPath = path.resolve(args.report);
}

const outDir = path.resolve(args.out || path.join(__dirname, 'dist'));
fs.mkdirSync(outDir, { recursive: true });

const report = loadReport(reportPath);
const history = loadHistory(historyDir, reportPath);
const latest = history[history.length - 1];
if (!latest || latest.reportFile !== path.basename(reportPath)) {
  console.error('latest report not found in history-dir — is --report from --history-dir?');
  process.exit(2);
}

// Copy the run's per-page audit reports (axe-html-reporter HTML) into docs/
// so the Pages table links resolve. Source is --pages-dir, or pages/ next
// to the report file (the audit runner writes it there). Replaced wholesale
// so docs/pages/ matches this run exactly.
const pagesSrc = args['pages-dir']
  ? path.resolve(args['pages-dir'])
  : path.join(path.dirname(path.resolve(args.report || reportPath)), 'pages');
if (fs.existsSync(pagesSrc) && fs.statSync(pagesSrc).isDirectory()) {
  fs.rmSync(path.join(outDir, 'pages'), { recursive: true, force: true });
  fs.cpSync(pagesSrc, path.join(outDir, 'pages'), { recursive: true });
}

const html = renderSite({ latest, history, args, report });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ siteGenerated: new Date().toISOString(), sourceRepo: TOOLS_REPO, report }, null, 2));
fs.writeFileSync(path.join(outDir, 'history.json'), JSON.stringify({ siteGenerated: new Date().toISOString(), series: history }, null, 2));

console.log(`Site built: ${outDir}`);
console.log(`  runs in history: ${history.length}`);
console.log(`  latest: ${latest.reportFile} — ${latest.totalViolations} node-level violations (${latest.pagesAudited} pages)`);
