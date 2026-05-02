const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

const AIRTABLE_TOKEN   = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = 'appuyQz7Xw85M0FdJ';

const TABLES = {
  redraft: {
    QB:      'tblXZGkOzs0Dkz7lC',
    RB:      'tblapSswDpU3OLUnN',
    WR:      'tbl2pCSphAX6AeIHK',
    TE:      'tblwCTbFFeNxqUDeo',
    Overall: 'tblhW63LJS2Bn0zdF',
    SF:      'tbl6BrcC8Z8pVTybK',
  },
  dynasty: {
    QB:      'tbliZIagJ34MddbEt',
    RB:      'tbls71q7nFt2sXbk8',
    WR:      'tblMz7V9Ey01cXITc',
    TE:      'tblvlw4JAdOe57rVp',
    Overall: 'tblhW63LJS2Bn0zdF',
    SF:      'tbl6BrcC8Z8pVTybK',
  },
};

// ── Static player data ────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, 'data');
const ADP_HIST_FILE = path.join(DATA_DIR, 'adp_history.json');

const scoutsRaw  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scouts.json'),  'utf8'));
const playersRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'players.json'), 'utf8'));

// Build name-keyed lookup (lowercase)
const scoutMap  = {};
(scoutsRaw.players  || []).forEach(p => { scoutMap[p.name.toLowerCase()]  = p; });
const injuryMap = {};
(playersRaw.players || []).forEach(p => { injuryMap[p.name.toLowerCase()] = p; });

// ── ADP history (persists to file between restarts) ──────────────────────────
let adpHistory = [];
try {
  adpHistory = JSON.parse(fs.readFileSync(ADP_HIST_FILE, 'utf8'));
} catch {}

function saveAdpHistory() {
  try { fs.writeFileSync(ADP_HIST_FILE, JSON.stringify(adpHistory)); } catch {}
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = {};

async function fetchTable(tableId) {
  const TTL = 5 * 60 * 1000;
  const now = Date.now();
  if (cache[tableId] && now - cache[tableId].ts < TTL) return cache[tableId].data;

  const records = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
    url.searchParams.set('sort[0][field]', 'Rank');
    url.searchParams.set('sort[0][direction]', 'asc');
    if (offset) url.searchParams.set('offset', offset);
    const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    (json.records || []).forEach(r => { if (r.fields.Player) records.push(r.fields); });
    offset = json.offset || null;
  } while (offset);

  cache[tableId] = { ts: now, data: records };
  return records;
}

async function fetchMFLAdp() {
  const TTL = 60 * 60 * 1000;
  const now = Date.now();
  if (cache.__mfl && now - cache.__mfl.ts < TTL) return cache.__mfl.data;

  const [playersRes, adpRes] = await Promise.all([
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=players&DETAILS=1&JSON=1'),
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=adp&FCOUNT=12&PERIOD=RECENT&PPR=1&IS_KEEPER=0&JSON=1'),
  ]);
  const playersJson = await playersRes.json();
  const adpJson     = await adpRes.json();

  const playerMap = {};
  (playersJson.players?.player || []).forEach(p => { playerMap[p.id] = p; });

  const adpMap = {};
  (adpJson.adp?.player || []).forEach(a => {
    const p = playerMap[a.id];
    if (!p || p.draft_year !== '2026') return;
    const parts = p.name.split(', ');
    const normalized = parts.length === 2 ? `${parts[1]} ${parts[0]}`.toLowerCase() : p.name.toLowerCase();
    adpMap[normalized] = parseFloat(a.averagePick).toFixed(1);
  });

  cache.__mfl = { ts: now, data: adpMap };

  // Store ADP snapshot for history (max 720 points = 30 days hourly)
  adpHistory.push({ ts: now, adpMap: { ...adpMap } });
  if (adpHistory.length > 720) adpHistory = adpHistory.slice(-720);
  saveAdpHistory();

  return adpMap;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rankings/:mode/:pos', async (req, res) => {
  const { mode, pos } = req.params;
  const tableId = TABLES[mode]?.[pos];
  if (!tableId) return res.status(400).json({ error: 'Invalid mode or position' });
  try {
    const [data, adpMap] = await Promise.all([fetchTable(tableId), fetchMFLAdp()]);
    const enriched = data.map(p => ({
      ...p,
      adp: adpMap[(p.Player || '').toLowerCase()] || null,
    }));
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name).toLowerCase();
  const scout  = scoutMap[name]  || null;
  const injury = injuryMap[name] || null;
  res.json({ scout, injury });
});

app.get('/api/adp/history/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name).toLowerCase();
  const history = adpHistory
    .map(snap => ({ ts: snap.ts, adp: snap.adpMap[name] ? parseFloat(snap.adpMap[name]) : null }))
    .filter(h => h.adp !== null);
  res.json(history);
});

app.get('/api/adp/last-updated', (req, res) => {
  res.json({ ts: cache.__mfl?.ts || null });
});

app.listen(PORT, () => console.log(`Rankings app running on port ${PORT}`));
