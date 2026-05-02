const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

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

// Cache: 5 min for rankings, 1 hour for ADP
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

  // Fetch players and ADP in parallel
  const [playersRes, adpRes] = await Promise.all([
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=players&DETAILS=1&JSON=1'),
    fetch('https://api.myfantasyleague.com/2026/export?TYPE=adp&FCOUNT=12&PERIOD=RECENT&PPR=1&IS_KEEPER=0&JSON=1'),
  ]);
  const playersJson = await playersRes.json();
  const adpJson     = await adpRes.json();

  const playerMap = {};
  (playersJson.players?.player || []).forEach(p => { playerMap[p.id] = p; });

  // Build name -> ADP map for 2026 rookies only
  const adpMap = {};
  (adpJson.adp?.player || []).forEach(a => {
    const p = playerMap[a.id];
    if (!p || p.draft_year !== '2026') return;
    // MFL name format: "Last, First" — convert to "First Last"
    const parts = p.name.split(', ');
    const normalized = parts.length === 2 ? `${parts[1]} ${parts[0]}`.toLowerCase() : p.name.toLowerCase();
    adpMap[normalized] = parseFloat(a.averagePick).toFixed(1);
  });

  cache.__mfl = { ts: now, data: adpMap };
  return adpMap;
}

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

app.get('/api/adp/last-updated', async (req, res) => {
  const ts = cache.__mfl?.ts;
  res.json({ ts: ts || null });
});

app.listen(PORT, () => console.log(`Rankings app running on port ${PORT}`));
