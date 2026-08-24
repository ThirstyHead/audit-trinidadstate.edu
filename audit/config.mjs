// Shared config for the audit pipeline. Every instance of this tooling repo
// carries its own college.json at the repo root describing the college it
// audits. All other scripts read their defaults from here, so a new college
// needs only college.json (+ audit/pages.json) — no code changes.
//
// Fields (all optional; FRCC values are the fallbacks):
//   name              College / org display name
//   slug              Short id (used in paths/logs)
//   domain            Audited domain, e.g. "frontrange.edu"
//   baseUrl           Base URL for relative pages.json entries (defaults to https://<domain>)
//   toolingRepo       GitHub repo name of this tooling (ThirstyHead/<toolingRepo>)
//   resultsRepo       GitHub repo name of the results/site repo (ThirstyHead/<resultsRepo>)
//   siteName          Name shown on the report site (defaults to name)
//   canonicalSiteUrl  Published site URL (defaults to https://thirstyhead.com/<resultsRepo>/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, '..', 'college.json');

const FALLBACK = {
  name: 'Front Range Community College',
  slug: 'frcc',
  domain: 'frontrange.edu',
  toolingRepo: 'audit-frontrange.edu',
  resultsRepo: 'frcc-audit',
};

let raw = {};
try {
  raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error(`config: cannot parse college.json: ${err.message}`);
    process.exit(1);
  }
}

const config = { ...FALLBACK, ...raw };
config.baseUrl = raw.baseUrl || `https://${config.domain}`;
config.siteName = raw.siteName || config.name;
config.canonicalSiteUrl =
  raw.canonicalSiteUrl || `https://thirstyhead.com/${config.resultsRepo}/`;
config.toolsRepoUrl = `https://github.com/ThirstyHead/${config.toolingRepo}`;
config.resultsRepoUrl = `https://github.com/ThirstyHead/${config.resultsRepo}`;

export default config;