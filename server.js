const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const fs      = require('fs');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Referer blocking ──────────────────────────────────────────────────────────
const BLOCKED_REFERERS = ['reddit.com', 'discord.com', 'discord.gg', 'redd.it'];
app.use((req, res, next) => {
  const referer = req.headers.referer || req.headers.referrer || '';
  if (BLOCKED_REFERERS.some(domain => referer.includes(domain))) {
    return res.status(403).sendFile(path.join(__dirname, 'public', 'blocked.html'));
  }
  next();
});

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
    SF:      'tbls95UbMeJ1RYkgm',
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
        WHERE s.pulled_at = (SELECT MAX(pulled_at) FROM adp_snapshots WHERE season = 2026 AND scoring = 'ppr')
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
  const TTL = 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (cache.__sleeperAdp && now - cache.__sleeperAdp.ts < TTL) return cache.__sleeperAdp.data;
  try {
    const url = 'https://api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=QB&position[]=RB&position[]=TE&position[]=WR&order_by=adp_dynasty_2qb';
    const res  = await fetch(url);
    const json = await res.json();
    const adpMap = {};
    const idMap  = {};
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
      const name = `${entry.player?.first_name || ''} ${entry.player?.last_name || ''}`.trim().toLowerCase();
      if (!name) return;
      if (Object.values(vals).some(x => x)) adpMap[name] = vals;
      if (entry.player_id) idMap[name] = entry.player_id;
    });
    cache.__sleeperAdp = { ts: now, data: adpMap };
    cache.__sleeperIds = idMap;
    return adpMap;
  } catch (e) {
    console.error('Sleeper ADP fetch failed:', e.message);
    return {};
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
// ── Airtable metadata: resolve table name → ID ───────────────────────────────
let atTableMeta = null;
let atTableMetaTs = 0;
const AT_META_TTL = 10 * 60 * 1000;

async function resolveAtTableId(name) {
  const now = Date.now();
  if (!atTableMeta || now - atTableMetaTs > AT_META_TTL) {
    const res  = await fetch(`https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const json = await res.json();
    atTableMeta = {};
    (json.tables || []).forEach(t => { atTableMeta[t.name] = t.id; });
    atTableMetaTs = now;
  }
  return atTableMeta[name] || null;
}

async function fetchTableByName(name) {
  const id = await resolveAtTableId(name);
  if (!id) return [];
  return fetchTable(id);
}

// Map frontend pos values → Airtable table suffix used by FantasyPro backend
const POS_AT_SUFFIX = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', Overall: 'OVERALL', SF: 'FLEX' };

// ── GET /api/rankings/redraft-consensus/:pos ──────────────────────────────────
// Returns consensus rankings for a position with per-creator rank columns.
// Pulls from Airtable tables written by the FantasyPro rankings admin on publish.
app.get('/api/rankings/redraft-consensus/:pos', async (req, res) => {
  const { pos } = req.params;
  const scoring = req.query.scoring || 'HalfPPR';
  const suffix  = POS_AT_SUFFIX[pos];
  if (!suffix) return res.status(400).json({ error: 'Invalid position' });

  try {
    // Get creator names from DB (same DB the FantasyPro backend uses)
    let creators = [];
    if (db) {
      try {
        const { rows } = await db.query(
          `SELECT auth_id, name FROM user_profiles WHERE role = 'creator' ORDER BY name ASC`
        );
        creators = rows.map(r => ({ id: r.auth_id, label: (r.name || r.auth_id).split(' ')[0] }));
      } catch (e) { console.error('creator lookup failed:', e.message); }
    }

    const conName      = `CON-${scoring}-${suffix}`;
    const creatorNames = creators.map(c => `${c.label}-${scoring}-${suffix}`);

    const [conData, ...creatorRows] = await Promise.all([
      fetchTableByName(conName),
      ...creatorNames.map(n => fetchTableByName(n).catch(() => [])),
    ]);

    // Build per-creator rank maps: lower-cased player name → rank
    const creatorMaps = creators.map((c, i) => {
      const m = {};
      (creatorRows[i] || []).forEach(p => { if (p.Player) m[p.Player.toLowerCase()] = p.Rank; });
      return { label: c.label, map: m };
    });

    // Enrich consensus rows with creator ranks
    const enriched = conData.map(p => {
      const key = (p.Player || '').toLowerCase();
      const extra = {};
      creatorMaps.forEach(c => { extra[c.label] = c.map[key] ?? null; });
      // Normalise position field (FantasyPro writes "Position", dynasty tables use "Pos")
      return { ...p, Pos: p.Pos || p.Position || pos, creatorRanks: extra };
    });

    // Get publish info from DB
    let publishInfo = null;
    if (db) {
      try {
        const { rows } = await db.query(`
          SELECT publish_label, publish_version, MAX(published_at) AS published_at
          FROM weekly_rankings
          WHERE season = 2026
            AND publish_version = (SELECT MAX(publish_version) FROM weekly_rankings WHERE season = 2026)
          GROUP BY publish_label, publish_version
          LIMIT 1
        `);
        if (rows[0]) publishInfo = { label: rows[0].publish_label, version: rows[0].publish_version, publishedAt: rows[0].published_at };
      } catch (e) { console.error('publishInfo failed:', e.message); }
    }

    res.json({ players: enriched, creators: creators.map(c => c.label), publishInfo });
  } catch (err) {
    console.error('/api/rankings/redraft-consensus error:', err);
    res.status(500).json({ error: err.message });
  }
});



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
  let attrs = null;
  if (db) {
    try {
      const { rows } = await db.query(`
        SELECT p.age, p.height, p.weight, p.position, p.team, p.status,
               ROUND(AVG(ps.fantasy_pts)::numeric, 1) AS avg_pts_2025,
               SUM(ps.targets)  AS targets_2025,
               SUM(ps.carries)  AS carries_2025,
               SUM(ps.rec_yards + ps.rush_yards) AS scrimmage_yards_2025,
               SUM(ps.pass_yards) AS pass_yards_2025,
               SUM(ps.pass_tds + ps.rush_tds + ps.rec_tds) AS tds_2025,
               COUNT(ps.week) AS games_2025
        FROM players p
        LEFT JOIN player_stats ps ON ps.player_id = p.id AND ps.season = 2025 AND ps.fantasy_pts > 0
        WHERE LOWER(p.name) = $1
        GROUP BY p.id
      `, [name]);
      if (rows[0]) attrs = rows[0];
    } catch {}
  }
  const sleeperId = cache.__sleeperIds?.[name] || null;
  res.json({ scout, injury, attrs, sleeperId });
});

app.get('/api/sleeper-ids', (req, res) => {
  res.json(cache.__sleeperIds || {});
});

app.get('/api/adp/history/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name).toLowerCase();
  if (!db) return res.json({ mfl: [], sleeper: [] });

  // Map app format key → which column to use
  const format = req.query.format || 'dynasty_1qb';
  const formatColMap = {
    dynasty_1qb:  'adp',
    dynasty_2qb:  'adp_dynasty_2qb',
    redraft_ppr:  'adp_ppr',
    redraft_half: 'adp_half_ppr',
    redraft_std:  'adp_std',
  };
  const adpCol = formatColMap[format] || 'adp';

  try {
    const sleeperId = cache.__sleeperIds?.[name];
    const [mflRes, sleeperRes] = await Promise.all([
      db.query(`
        SELECT s.pulled_at AS ts, s.adp
        FROM adp_snapshots s
        JOIN players p ON p.id = s.player_id
        WHERE LOWER(p.name) = $1 AND s.season = 2026 AND s.scoring = 'ppr'
        ORDER BY s.pulled_at ASC
      `, [name]),
      sleeperId
        ? db.query(`
            SELECT pulled_at AS ts, ${adpCol} AS adp
            FROM sleeper_adp_history
            WHERE sleeper_player_id = $1 AND season = 2026
              AND ${adpCol} IS NOT NULL
            ORDER BY pulled_at ASC
          `, [sleeperId])
        : Promise.resolve({ rows: [] }),
    ]);
    res.json({
      mfl:     mflRes.rows.map(r => ({ ts: new Date(r.ts).getTime(), adp: parseFloat(r.adp) })),
      sleeper: sleeperRes.rows.map(r => ({ ts: new Date(r.ts).getTime(), adp: parseFloat(r.adp) })),
    });
  } catch (err) {
    console.error('adp/history failed:', err.message);
    res.json({ mfl: [], sleeper: [] });
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

// ── Player attributes (age / height / weight from Sleeper, stored in DB) ──────
async function ensureAttrsColumns() {
  if (!db) return;
  try {
    await db.query(`
      ALTER TABLE players
        ADD COLUMN IF NOT EXISTS age     INT,
        ADD COLUMN IF NOT EXISTS height  VARCHAR(20),
        ADD COLUMN IF NOT EXISTS weight  INT
    `);
  } catch (e) { console.error('ensureAttrsColumns:', e.message); }
}

async function syncPlayerAttrs() {
  if (!db) return { error: 'No DB' };
  await ensureAttrsColumns();
  try {
    const res  = await fetch('https://api.sleeper.app/v1/players/nfl');
    const json = await res.json();
    const byName = {};
    Object.values(json).forEach(p => {
      if (p.full_name) byName[p.full_name.toLowerCase()] = p;
    });
    const { rows } = await db.query('SELECT id, name FROM players');
    let updated = 0;
    for (const row of rows) {
      const s = byName[row.name.toLowerCase()];
      if (!s) continue;
      await db.query(
        'UPDATE players SET age=$1, height=$2, weight=$3 WHERE id=$4',
        [s.age || null, s.height || null, s.weight ? parseInt(s.weight) : null, row.id]
      );
      updated++;
    }
    return { updated, total: rows.length };
  } catch (e) { return { error: e.message }; }
}

app.post('/api/admin/sync-attrs', async (req, res) => {
  const result = await syncPlayerAttrs();
  res.json(result);
});

// ── Sleeper player ID map (full roster, for photo fallback) ───────────────────
async function initSleeperIdMap() {
  try {
    const res  = await fetch('https://api.sleeper.app/v1/players/nfl');
    const json = await res.json();
    const idMap = {};
    Object.entries(json).forEach(([id, p]) => {
      if (p.full_name) idMap[p.full_name.toLowerCase()] = id;
    });
    cache.__sleeperIds = idMap;
    console.log(`Sleeper ID map loaded: ${Object.keys(idMap).length} players`);
  } catch (e) { console.error('initSleeperIdMap failed:', e.message); }
}

// ── Add published_at to weekly_rankings (FantasyPro shared table) ───────────
async function ensurePublishedAt() {
  if (!db) return;
  try {
    await db.query(`ALTER TABLE weekly_rankings ADD COLUMN IF NOT EXISTS published_at TIMESTAMP DEFAULT NOW()`);
  } catch (e) { console.error('ensurePublishedAt:', e.message); }
}

// ── Sleeper ADP snapshots ─────────────────────────────────────────────────────
async function ensureSourceColumn() {
  if (!db) return;
  try {
    await db.query(`ALTER TABLE adp_snapshots ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'mfl'`);
    await db.query(`ALTER TABLE adp_snapshots ALTER COLUMN scoring TYPE VARCHAR(20)`);
  } catch (e) { console.error('ensureSourceColumn:', e.message); }
}

async function ensureSleeperHistoryTable() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sleeper_adp_history (
        id               SERIAL PRIMARY KEY,
        sleeper_player_id VARCHAR(20) NOT NULL,
        adp              DECIMAL(6,1) NOT NULL,
        pulled_at        TIMESTAMP NOT NULL,
        season           INT NOT NULL DEFAULT 2026
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_sleeper_adp_hist
      ON sleeper_adp_history(sleeper_player_id, season, pulled_at)
    `);
    // Add per-format columns (safe to run repeatedly — no-op if already exist)
    await db.query(`
      ALTER TABLE sleeper_adp_history
        ADD COLUMN IF NOT EXISTS adp_ppr          DECIMAL(6,1),
        ADD COLUMN IF NOT EXISTS adp_half_ppr     DECIMAL(6,1),
        ADD COLUMN IF NOT EXISTS adp_std          DECIMAL(6,1),
        ADD COLUMN IF NOT EXISTS adp_dynasty_2qb  DECIMAL(6,1)
    `);
  } catch (e) { console.error('ensureSleeperHistoryTable:', e.message); }
}

async function saveSleeperAdpSnapshots() {
  if (!db) return;
  try {
    delete cache.__sleeperAdp; // force fresh fetch so each snapshot reflects current Sleeper data
    const sleeperMap = await fetchSleeperAdpMap(); // also populates cache.__sleeperIds
    const idMap = cache.__sleeperIds || {};
    const now = new Date();
    let saved = 0;
    for (const [name, vals] of Object.entries(sleeperMap)) {
      const sleeperId = idMap[name];
      if (!sleeperId) continue;
      // Require at least one ADP value to be present
      if (!vals.dynastyPpr && !vals.ppr && !vals.halfPpr && !vals.std && !vals.dynasty2qb) continue;
      await db.query(
        `INSERT INTO sleeper_adp_history
           (sleeper_player_id, adp, adp_ppr, adp_half_ppr, adp_std, adp_dynasty_2qb, pulled_at, season)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2026)`,
        [
          sleeperId,
          vals.dynastyPpr ? parseFloat(vals.dynastyPpr) : null,
          vals.ppr        ? parseFloat(vals.ppr)        : null,
          vals.halfPpr    ? parseFloat(vals.halfPpr)    : null,
          vals.std        ? parseFloat(vals.std)        : null,
          vals.dynasty2qb ? parseFloat(vals.dynasty2qb) : null,
          now,
        ]
      );
      saved++;
    }
    console.log(`Saved ${saved} Sleeper ADP snapshots`);
  } catch (e) { console.error('saveSleeperAdpSnapshots failed:', e.message); }
}


Promise.all([ensureSourceColumn(), ensureSleeperHistoryTable(), ensurePublishedAt()]).then(() => {
  app.listen(PORT, () => {
    console.log(`Rankings app running on port ${PORT}`);
    initSleeperIdMap();
    saveSleeperAdpSnapshots();
    setInterval(saveSleeperAdpSnapshots, 2 * 60 * 60 * 1000);
  });
}).catch(e => {
  console.error('DB migration failed, starting anyway:', e.message);
  app.listen(PORT, () => {
    console.log(`Rankings app running on port ${PORT}`);
    initSleeperIdMap();
  });
});
