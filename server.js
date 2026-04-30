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

// Simple in-memory cache (5 min TTL)
const cache = {};
const CACHE_TTL = 5 * 60 * 1000;

async function fetchTable(tableId) {
  const now = Date.now();
  if (cache[tableId] && now - cache[tableId].ts < CACHE_TTL) {
    return cache[tableId].data;
  }

  const records = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}`);
    url.searchParams.set('sort[0][field]', 'Rank');
    url.searchParams.set('sort[0][direction]', 'asc');
    if (offset) url.searchParams.set('offset', offset);

    const res  = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);

    (json.records || []).forEach(r => {
      if (r.fields.Player) records.push(r.fields);
    });
    offset = json.offset || null;
  } while (offset);

  cache[tableId] = { ts: now, data: records };
  return records;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rankings/:mode/:pos', async (req, res) => {
  const { mode, pos } = req.params;
  const tableId = TABLES[mode]?.[pos];
  if (!tableId) return res.status(400).json({ error: 'Invalid mode or position' });

  try {
    const data = await fetchTable(tableId);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Rankings app running on port ${PORT}`));
