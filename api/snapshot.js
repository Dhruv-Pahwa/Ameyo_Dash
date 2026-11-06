// Vercel function: saves the two Google Sheets into history/ in the GitHub repo, as one commit.
// An outside scheduler (e.g. cron-job.org) calls it once an evening:
//   GET https://<site>/api/snapshot?key=<SNAPSHOT_SECRET>
// Environment variables (Vercel project settings):
//   SNAPSHOT_SECRET  any long random string; calls without it are refused
//   GITHUB_TOKEN     fine-grained token for this repo with "Contents: Read and write"
//   GITHUB_REPO      optional, "owner/name" (default below)
//   GITHUB_BRANCH    optional (default "main")

const PROD_URL = 'https://docs.google.com/spreadsheets/d/1ZU0r6Mr0WVz-AD65Jn3uPHsnnCO9ssDepIupeFmOwsA/export?format=csv';
const BREAK_URL = 'https://docs.google.com/spreadsheets/d/17ortJZIjY3O08iVyW_nryiiOQlo6K0ielPSpL1oKtf8/export?format=csv';
const DEFAULT_REPO = 'Dhruv-Pahwa/Ameyo_Dash';
const HISTORY_DIR = 'history';
// History is only trusted from this day on; earlier days are not kept.
const FIRST_DAY = '2026-11-06';

async function fetchSheet(url, name) {
  const resp = await fetch(url, { redirect: 'follow', cache: 'no-store' });
  if (!resp.ok) throw new Error(`The ${name} sheet returned HTTP ${resp.status}`);
  const text = (await resp.text()).replace(/^﻿/, '');
  // A sign-in page or an empty sheet is not a snapshot.
  if (text.split(/\r?\n/).filter(Boolean).length < 2 || /<html/i.test(text.slice(0, 300))) {
    throw new Error(`The ${name} sheet returned no data rows (is it still shared as "anyone with the link"?)`);
  }
  return text;
}

// The day of the data: the most common dd/mm/yyyy in the break sheet's "Ready Start Time" column.
function dataDay(breakCsv) {
  const lines = breakCsv.split(/\r?\n/);
  const col = lines[0].split(',').map(h => h.trim()).indexOf('Ready Start Time');
  if (col < 0) return '';
  const counts = {};
  for (let i = 1; i < lines.length; i++) {
    const m = (lines[i].split(',')[col] || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    const day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    counts[day] = (counts[day] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : '';
}

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function takeSnapshot(env) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ameyo-dash-snapshot',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  });
  const ghJson = async (path, opts) => {
    const resp = await gh(path, opts);
    if (!resp.ok) throw new Error(`GitHub ${(opts && opts.method) || 'GET'} ${path} -> ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  };
  // Current content of a file in the repo, or null when it does not exist.
  const readRepoFile = async path => {
    const resp = await gh(`/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub read ${path} -> ${resp.status}`);
    return resp.text();
  };

  const [prod, breaks] = await Promise.all([fetchSheet(PROD_URL, 'productivity'), fetchSheet(BREAK_URL, 'break')]);
  const day = dataDay(breaks) || istToday();
  if (day < FIRST_DAY) return { saved: false, day, reason: `The sheet holds ${day}, before ${FIRST_DAY}; not saving.` };

  const prodPath = `${HISTORY_DIR}/${day}.csv`;
  const breakPath = `${HISTORY_DIR}/${day}-breaks.csv`;
  const indexPath = `${HISTORY_DIR}/index.json`;
  const [oldProd, oldBreaks, oldIndex] = await Promise.all([readRepoFile(prodPath), readRepoFile(breakPath), readRepoFile(indexPath)]);
  if (oldProd === prod && oldBreaks === breaks) return { saved: false, day, reason: 'Sheet is unchanged for this day; nothing to save.' };

  let dates = [];
  try { dates = JSON.parse(oldIndex || '{}').dates || []; } catch (e) { /* rebuilt below */ }
  const indexText = JSON.stringify({ dates: [...new Set([...dates, day])].sort() }) + '\n';

  // One commit for all three files, so the site is redeployed once.
  const head = await ghJson(`/git/ref/heads/${encodeURIComponent(branch)}`);
  const parent = await ghJson(`/git/commits/${head.object.sha}`);
  const files = [[prodPath, prod], [breakPath, breaks], [indexPath, indexText]];
  const entries = [];
  for (const [path, content] of files) {
    const blob = await ghJson('/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding: 'utf-8' }) });
    entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await ghJson('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) });
  const commit = await ghJson('/git/commits', { method: 'POST', body: JSON.stringify({ message: `Snapshot ${day}`, tree: tree.sha, parents: [head.object.sha] }) });
  await ghJson(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return { saved: true, day, commit: commit.sha };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.SNAPSHOT_SECRET;
  const given = (req.query && req.query.key) || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret) { res.status(500).json({ error: 'SNAPSHOT_SECRET is not set' }); return; }
  if (given !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'GITHUB_TOKEN is not set' }); return; }
  try {
    res.status(200).json(await takeSnapshot(process.env));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
module.exports.takeSnapshot = takeSnapshot;
module.exports.dataDay = dataDay;
