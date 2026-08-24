# cccs-audit-template

Canonical core for the CCCS "Power of 13" WCAG audit pipeline. Each of the 14
instances (13 colleges + the CCCS system site) is an independent tooling repo
created from this template that differs **only by `college.json` (+
`audit/pages.json`)** — the code is identical across instances.

Do not edit this template to add college-specific content. Core changes land
here first (as a PR), then propagate to each instance repo as a "sync core"
update.

## Instance layout

| Field | Meaning |
|---|---|
| `name` / `slug` | Display name / short id |
| `domain` / `baseUrl` | Audited domain and base URL for `pages.json` paths |
| `toolingRepo` / `resultsRepo` | `ThirstyHead/<…>` repo names (results repo = the Pages site) |
| `siteName` / `canonicalSiteUrl` | Report-site branding and published URL |

- `college.json` — **instance config** (repo root). Every other script reads its
  defaults from here via `audit/config.mjs`.
- `audit/axe-audit.mjs` — Playwright + axe-core audit runner; also renders a
  standalone per-page HTML audit report via
  [axe-html-reporter](https://www.npmjs.com/package/axe-html-reporter).
- `audit/pages.json` — the list of audited pages (`{ baseUrl, pages[] }`).
- `audit/discover-pages.mjs` — one-time curation AID (not CI) that crawls the
  homepage, keeps same-host HTML links, verifies each candidate returns 200,
  and writes a candidate `pages.json` for human review.
- `site/build-site.mjs` — renders the public GitHub Pages site from report JSON.
- `.github/workflows/weekly-audit.yml` — weekly scheduled run (Mondays 06:00 UTC)
  + on-demand `workflow_dispatch`.

## Publishing pipeline

1. The workflow installs deps + Chromium, runs the audit (`npm test`).
2. It pushes the new report JSON (plus the run's per-page HTML reports) to the
   results repo named in `college.json`, using the `RESULTS_TOKEN` repository
   secret.
3. It renders the site into that repo's `docs/` folder — served by GitHub Pages.

> **Note on `RESULTS_TOKEN`:** the default `GITHUB_TOKEN` is scoped to this repo
> only and cannot push to a sibling results repo (it 403s). The publish step
> requires a `RESULTS_TOKEN` repository secret: any token that can write to the
> results repo (e.g. a fine-grained PAT with Contents: read/write). Set it
> **per instance repo**.

Enabling Pages in the results repo (one-time): results repo → Settings → Pages
→ Deploy from a branch → `main` / `docs`.

## Setup a new instance

1. Create the tooling repo from this template (or clone it) as `audit-<domain>`.
2. Fill in `college.json` (name, slug, domain, baseUrl, toolingRepo, resultsRepo,
   siteName, canonicalSiteUrl).
3. Generate a candidate page list: `node audit/discover-pages.mjs`, then review
   and commit it as `audit/pages.json`.
4. Create the results repo (`<abbr>-audit`); seed a minimal `main` commit so
   Pages has a base branch.
5. Enable GitHub Pages on the results repo: `main` / `docs`.
6. Add the `RESULTS_TOKEN` secret to the **tooling** repo (write access to the
   results repo).
7. Dry-run via Actions → `workflow_dispatch` and confirm the results repo's
   `docs/` renders.

## Usage

```bash
npm test                                  # audit all pages in audit/pages.json
node audit/axe-audit.mjs <url>            # audit specific URL(s) instead
node audit/discover-pages.mjs             # generate candidate pages.json
npm run site:build -- --latest --history-dir <reports-dir>   # build site locally
```
