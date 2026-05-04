const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const { Pool } = require('pg');

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
const DATA_DIR = path.join(__dirname, 'data');

const scoutsRaw  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scouts.json'),  'utf8'));
const playersRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'players.json'), 'utf8'));

// Build name-keyed lookup (lowercase)
const scoutMap  = {};
(scoutsRaw.players  || []).forEach(p => { scoutMap[p.name.toLowerCase()]  = p; });
const injuryMap = {};
(playersRaw.players || []).forEach(p => { injuryMap[p.name.toLowerCase()] = p; });

// ── Postgres ──────────────────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

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

// Reads latest ADP snapshot from the shared Postgres table (populated by the other app).
// Falls back to direct MFL API call if DB is unavailable.
async function fetchAdpMap() {
  const TTL = 5 * 60 * 1000;
  const now = Date.now();
  if (cache.__adp && now - cache.__adp.ts < TTL) return cache.__adp.data;

  if (db) {
    try {
      const { rows } = await db.query(`
        SELECT p.name, s.adp, s.pulled_at
        FROM adp_snapshots s
        JOIN players p ON p.id = s.player_id
        WHERE s.pulled_at = (SELECT MAX(pulled_at) FROM adp_snapshots WHERE season = 2026)
          AND s.season = 2026 AND s.scoring = 'ppr'
      `);
      const adpMap = {};
      rows.forEach(r => { adpMap[r.name.toLowerCase()] = parseFloat(r.adp).toFixed(1); });
      cache.__adp = { ts: now, data: adpMap, lastPulled: rows[0]?.pulled_at || null };
      return adpMap;
    } catch (e) { console.error('DB ADP fetch failed, falling back to MFL:', e.message); }
  }

  // Fallback: direct MFL API
  const [playersRes, adpRes] = await Promise.all([
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=players&DETAILS=1&JSON=1'),
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=adp&FCOUNT=12&PERIOD=RECENT&PPR=1&IS_KEEPER=0&JSON=1'),
  ]);
  const playersJson = await playersRes.json();
  const adpJson     = await adpRes.json();
  const playerMap   = {};
  (playersJson.players?.player || []).forEach(p => { playerMap[p.id] = p; });
  const adpMap = {};
  (adpJson.adp?.player || []).forEach(a => {
    const p = playerMap[a.id];
    if (!p || p.draft_year !== '2026') return;
    const parts = p.name.split(', ');
    const normalized = parts.length === 2 ? `${parts[1]} ${parts[0]}`.toLowerCase() : p.name.toLowerCase();
    adpMap[normalized] = parseFloat(a.averagePick).toFixed(1);
  });
  cache.__adp = { ts: now, data: adpMap, lastPulled: null };
  return adpMap;
}

// ── Sleeper ADP ───────────────────────────────────────────────────────────────
async function fetchSleeperAdpMap() {
  const TTL = 5 * 60 * 1000;
  const now = Date.now();
  if (cache.__sleeperAdp && now - cache.__sleeperAdp.ts < TTL) return cache.__sleeperAdp.data;
  try {
    const url = 'https://api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=QB&position[]=RB&position[]=TE&position[]=WR&order_by=adp_dynasty_2qb';
    const res  = await fetch(url);
    const json = await res.json();
    const adpMap = {};
    (Array.isArray(json) ? json : []).forEach(entry => {
      const s = entry.stats || {};
      const v = f => (f != null && f < 999) ? parseFloat(f).toFixed(1) : null;
      const vals = {
        ppr:        v(s.adp_ppr),
        halfPpr:    v(s.adp_half_ppr),
        std:        v(s.adp_std),
        dynastyPpr: v(s.adp_dynasty_ppr),
        dynasty2qb: v(s.adp_dynasty_2qb),
      };
      if (!Object.values(vals).some(x => x)) return;
      const name = `${entry.player?.first_name || ''} ${entry.player?.last_name || ''}`.trim().toLowerCase();
      if (name) adpMap[name] = vals;
    });
    cache.__sleeperAdp = { ts: now, data: adpMap };
    return adpMap;
  } catch (e) {
    console.error('Sleeper ADP fetch failed:', e.message);
    return {};
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rankings/:mode/:pos', async (req, res) => {
  const { mode, pos } = req.params;
  const tableId = TABLES[mode]?.[pos];
  if (!tableId) return res.status(400).json({ error: 'Invalid mode or position' });
  try {
    const format = req.query.format || 'dynasty_1qb';
    const sleeperFieldMap = {
      dynasty_1qb:  'dynastyPpr',
      dynasty_2qb:  'dynasty2qb',
      redraft_ppr:  'ppr',
      redraft_half: 'halfPpr',
      redraft_std:  'std',
    };
    const sf = sleeperFieldMap[format] || 'dynastyPpr';
    const [data, adpMap, sleeperAdpMap] = await Promise.all([fetchTable(tableId), fetchAdpMap(), fetchSleeperAdpMap()]);
    const enriched = data.map(p => {
      const sEntry = sleeperAdpMap[(p.Player || '').toLowerCase()];
      return {
        ...p,
        adp:        adpMap[(p.Player || '').toLowerCase()] || null,
        sleeperAdp: sEntry?.[sf] || null,
      };
    });
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

app.get('/api/adp/history/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name).toLowerCase();
  if (!db) return res.json([]);
  try {
    const { rows } = await db.query(`
      SELECT s.pulled_at AS ts, s.adp
      FROM adp_snapshots s
      JOIN players p ON p.id = s.player_id
      WHERE LOWER(p.name) = $1 AND s.season = 2026 AND s.scoring = 'ppr'
      ORDER BY s.pulled_at ASC
    `, [name]);
    res.json(rows.map(r => ({ ts: new Date(r.ts).getTime(), adp: parseFloat(r.adp) })));
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.get('/api/adp/last-updated', async (req, res) => {
  if (cache.__adp?.lastPulled) return res.json({ ts: new Date(cache.__adp.lastPulled).getTime() });
  if (!db) return res.json({ ts: null });
  try {
    const { rows } = await db.query('SELECT MAX(pulled_at) AS ts FROM adp_snapshots WHERE season = 2026');
    res.json({ ts: rows[0]?.ts ? new Date(rows[0].ts).getTime() : null });
  } catch { res.json({ ts: null }); }
});

app.listen(PORT, () => console.log(`Rankings app running on port ${PORT}`));
