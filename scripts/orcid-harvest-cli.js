/**
 * Login as admin + POST /api/orcid/harvest (all active NCV, or filtered subset).
 *
 * Env: ORCID_CLI_EMAIL, ORCID_CLI_PASSWORD
 * Optional env filters (comma-separated): ORCID_HARVEST_NAMES, ORCID_HARVEST_IDS, ORCID_HARVEST_ORCIDS
 * Optional: BASE_URL (default http://localhost:PORT), PORT (default 3000)
 *
 * CLI examples (from repo root):
 *   npm run orcid:harvest
 *   npm run orcid:harvest -- --name "Phạm Văn Phúc" --name "Nguyễn Trường Sinh"
 *   node scripts/orcid-harvest-cli.js --id 3 --id 7
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
  /\/$/,
  ''
);
const email = (process.env.ORCID_CLI_EMAIL || '').trim();
const password = process.env.ORCID_CLI_PASSWORD || '';

function parseCliArgs(argv) {
  const names = [];
  const ids = [];
  const orcids = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { help: true, names, ids, orcids };
    }
    if (a === '--name' && argv[i + 1] !== undefined) {
      names.push(argv[++i]);
      continue;
    }
    if (a.startsWith('--name=')) {
      names.push(a.slice('--name='.length));
      continue;
    }
    if (a === '--id' && argv[i + 1] !== undefined) {
      ids.push(argv[++i]);
      continue;
    }
    if (a.startsWith('--id=')) {
      ids.push(a.slice('--id='.length));
      continue;
    }
    if (a === '--orcid' && argv[i + 1] !== undefined) {
      orcids.push(argv[++i]);
      continue;
    }
    if (a.startsWith('--orcid=')) {
      orcids.push(a.slice('--orcid='.length));
      continue;
    }
  }

  const envNames = (process.env.ORCID_HARVEST_NAMES || '').trim();
  if (envNames) {
    envNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => names.push(n));
  }
  const envIds = (process.env.ORCID_HARVEST_IDS || '').trim();
  if (envIds) {
    envIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => ids.push(n));
  }
  const envOrc = (process.env.ORCID_HARVEST_ORCIDS || '').trim();
  if (envOrc) {
    envOrc
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => orcids.push(n));
  }

  return { help: false, names, ids, orcids };
}

function buildHarvestBody({ names, ids, orcids }) {
  const body = {};
  if (names.length) {
    body.fullNames = names.map((s) => String(s).trim()).filter(Boolean);
  }
  if (ids.length) {
    body.researcherIds = ids
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  if (orcids.length) {
    body.orcidIds = orcids.map((s) => String(s).trim()).filter(Boolean);
  }
  return body;
}

function printHelp() {
  console.error(`Usage: node scripts/orcid-harvest-cli.js [options]
  (no args)     Harvest all NCV with is_active=1
  --name "..."  Full name match (NFC trim, case-insensitive); repeat for multiple
  --id N        researcher_orcids.id; repeat allowed
  --orcid ID    ORCID iD; repeat allowed
Env (comma-separated lists): ORCID_HARVEST_NAMES, ORCID_HARVEST_IDS, ORCID_HARVEST_ORCIDS
Requires: ORCID_CLI_EMAIL, ORCID_CLI_PASSWORD in .env`);
}

async function main() {
  const parsed = parseCliArgs(process.argv);
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  if (!email || !password) {
    console.error('Missing ORCID_CLI_EMAIL or ORCID_CLI_PASSWORD.');
    console.error('Example: set ORCID_CLI_EMAIL=admin@... && set ORCID_CLI_PASSWORD=... && npm run orcid:harvest');
    process.exit(1);
  }

  const harvestBody = buildHarvestBody(parsed);
  const hasFilter = Object.keys(harvestBody).length > 0;
  if (hasFilter) {
    console.error('[orcid:harvest] Filter:', JSON.stringify(harvestBody));
  }

  console.error('[orcid:harvest] Server:', base);

  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) {
    console.error('Login failed:', loginJson.message || loginRes.status);
    process.exit(1);
  }
  const token = loginJson.token;
  if (!token) {
    console.error('Response has no token.');
    process.exit(1);
  }
  console.error('[orcid:harvest] Login OK.');
  const r = String((loginJson.user && loginJson.user.role) || '').toLowerCase();
  if (r !== 'admin') {
    console.warn('Warning: admin role is required for harvest — you may get 403.');
  }

  console.error(
    '[orcid:harvest] Waiting for server ORCID harvest — can take several minutes; no output is normal.'
  );
  console.error('[orcid:harvest] See the npm start terminal for detailed logs.');
  const heartbeat = setInterval(() => {
    console.error('[orcid:harvest] … still running on server …');
  }, 45000);

  const headers = { Authorization: `Bearer ${token}` };
  if (hasFilter) {
    headers['Content-Type'] = 'application/json';
  }

  let hRes;
  try {
    hRes = await fetch(`${base}/api/orcid/harvest`, {
      method: 'POST',
      headers,
      body: hasFilter ? JSON.stringify(harvestBody) : undefined,
    });
  } finally {
    clearInterval(heartbeat);
  }

  const hJson = await hRes.json().catch(() => ({}));
  if (!hRes.ok) {
    console.error('Harvest error:', hJson.message || hJson.error || hRes.status);
    process.exit(1);
  }
  console.log(JSON.stringify(hJson, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
