# W4TRC Field Day Live Dashboard — Build Spec

A public, real-time Field Day dashboard for W4TRC. N1MM+ logs at the site; a tiny
local agent ships each QSO out over HTTPS to a Cloudflare Worker; the Worker stores
QSOs in D1 and serves an edge-cached public page. Because the page is served from
Cloudflare's edge, viewers never touch the Starlink uplink — only the lightweight,
retry-able ingest POSTs cross the dish.

## Goals (must-have)
- Total contacts
- Contacts per band
- Contacts per operator
- ARRL/RAC sections worked (mark off which sections we've contacted)

## Nice-to-have (build if time)
- QSO rate (last hour, last 10 min)
- Cumulative QSO line chart over the event
- Live "recent QSOs" ticker, with a flash/chime when a *new section* is worked
- "Sections needed" view (invert the worked set — turns the board into a tasking tool)
- Points/score estimate (or ingest N1MM's Score packet directly)
- Who's on what band right now (from the N1MM Radio packet)
- Maps or fancy graphics

---

## Architecture

```
[N1MM+ PCs] --UDP/12060--> [Local Agent (site mini PC)] --HTTPS POST--> [Worker /ingest] --> [D1]
                                                                              |
[Public browsers / on-site TV] <--- edge-cached --- [Worker / Pages frontend] <-- GET /api/stats
```

Four components:
1. **Local agent** — Node.js. Listens on UDP 12060, parses N1MM XML, POSTs each QSO to the Worker. Local persistent queue so Starlink blips lose nothing.
2. **Cloudflare Worker** — `/ingest` (auth + upsert into D1), `/api/stats` (aggregates as JSON), `/` (serve frontend).
3. **D1 database** — one `qsos` table keyed on N1MM's GUID.
4. **Frontend** — static page polling `/api/stats` every 15-60s. TV-friendly. Edge-cached.

Hard constraint: **Workers cannot receive UDP.** The local agent is the bridge and is not optional. Everything else is standard Workers + D1 + Pages.

---

## Component 1 — Local Ingest Agent (Node.js)

Runs on the site mini PC. Single file + a small on-disk queue. No inbound ports, just outbound HTTPS — works behind Starlink CGNAT with zero tunnel.

### Responsibilities
- Open a UDP socket on `0.0.0.0:12060` with `SO_REUSEADDR` (so it can coexist with other N1MM listeners).
- Parse three packet types: `contactinfo`, `contactreplace`, `contactdelete`.
- Normalize fields, then enqueue an upsert (info/replace) or delete.
- Drain the queue to the Worker over HTTPS with a shared-secret header. Retry with backoff; persist the queue to disk so a crash or outage doesn't drop QSOs.

### N1MM packet facts that matter (don't let Claude Code guess these)
- **`<ID>`** is a 32-byte unique GUID per contact (sent as hex). Use it as the primary key → every ingest is an idempotent upsert. Retries and edits self-heal.
- **`<band>`** can arrive locale-delimited ("3.5" or "3,5"). Normalize commas to dots and map to a canonical band label (see `BAND_MAP`).
- **`<section>`** for ARRL Field Day = the ARRL/RAC section (exactly what we want for the map). Per N1MM docs this field is contest-defined, so **print one live packet during setup to confirm** before trusting it.
- **`<operator>`** = the op who logged it → per-operator stats.
- **`<IsOriginal>`** is `True` on the station that first logged the QSO, `False` on a station re-forwarding it. In a multi-op networked setup, enable **Contacts + "All Computers"** on ONE networked PC pointed at the agent; that PC forwards every QSO from the whole network, so you only configure one destination. Dedup-by-ID makes any doubling harmless.
- `contactdelete` carries call + timestamp (and `oldcall`/`oldtimestamp`); modern builds also include `<ID>`. Delete by ID when present, else by (call, timestamp).

### Parser core (starter — keep this logic)
```js
import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

const BAND_MAP = {
  '1.8': '160m', '3.5': '80m', '5.3': '60m', '7': '40m', '10': '30m',
  '14': '20m', '18': '17m', '21': '15m', '24': '12m', '28': '10m',
  '50': '6m', '144': '2m', '222': '1.25m', '420': '70cm'
};

function normBand(b) {
  if (!b) return 'unknown';
  const key = String(b).replace(',', '.').trim();
  return BAND_MAP[key] || key;
}

function extractContact(node) {
  // node = parsed <contactinfo> or <contactreplace> object
  return {
    id: String(node.ID || '').toLowerCase(),
    call: (node.call || '').toUpperCase(),
    band: normBand(node.band),
    mode: node.mode || '',
    operator: (node.operator || '').toUpperCase(),
    section: (node.section || '').toUpperCase().trim(),
    ts: node.timestamp || '',
    points: Number(node.points || 0),
    is_original: String(node.IsOriginal).toLowerCase() === 'true'
  };
}

function handlePacket(buf) {
  const text = buf.toString('utf8');
  const doc = xml.parse(text);
  if (doc.contactinfo)    return { op: 'upsert', qso: extractContact(doc.contactinfo) };
  if (doc.contactreplace) return { op: 'upsert', qso: extractContact(doc.contactreplace) };
  if (doc.contactdelete) {
    const d = doc.contactdelete;
    return { op: 'delete', id: String(d.ID || '').toLowerCase(),
             call: (d.call || '').toUpperCase(), ts: d.timestamp || '' };
  }
  return null; // ignore radioinfo / spot / score here unless implementing bonus features
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (msg) => {
  const evt = handlePacket(msg);
  if (evt) enqueue(evt);          // enqueue() = append to disk-backed queue
});
sock.bind(Number(process.env.UDP_PORT || 12060));
```

### Queue + sender (requirements, let Claude Code implement)
- Disk-backed FIFO (a JSONL file or a tiny better-sqlite3 table). Append on receive; a sender loop POSTs batches to `${WORKER_URL}/ingest`.
- POST body: `{ events: [...] }`. Header: `Authorization: Bearer ${INGEST_SECRET}`.
- On success, advance the queue cursor. On failure, exponential backoff (cap ~30s) and retry forever. Never drop on network error.
- Config via env: `WORKER_URL`, `INGEST_SECRET`, `UDP_PORT`.
- Ship a `--replay <adif-or-log>` or just rely on N1MM's `replayer.py` to fire test packets for a dry run.

---

## Component 2 — Cloudflare Worker

### Routes
- `POST /ingest` — auth via shared secret; validate; upsert/delete in D1. Returns `{ok:true}`.
- `GET /api/stats` — returns the aggregate JSON (below). Set `Cache-Control: public, s-maxage=5` so the edge absorbs a crowd; viewers hitting cache never reach the origin.
- `GET /` — serve the frontend (or split the frontend to Pages and keep the Worker API-only).

### wrangler.toml (outline)
```toml
name = "w4trc-fieldday"
main = "src/index.js"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "fieldday"
database_id = "<from wrangler d1 create>"

# INGEST_SECRET set via: wrangler secret put INGEST_SECRET
```

### Ingest handler (behavior)
- Reject if `Authorization` != `Bearer ${env.INGEST_SECRET}`.
- For each event: `upsert` → `INSERT ... ON CONFLICT(id) DO UPDATE`; `delete` → delete by id (or call+ts fallback).
- Batch with D1 `batch()` for throughput.

### /api/stats shape
```json
{
  "updated": "2026-06-28T18:43:38Z",
  "total": 412,
  "byBand":     [{ "band": "20m", "count": 180 }, ...],
  "byOperator": [{ "operator": "N4JHC", "count": 96 }, ...],
  "sectionsWorked": ["CT","TN","NFL", ...],
  "rateLastHour": 73,
  "recent": [{ "call": "W1AW", "band": "20m", "operator": "N4JHC", "section": "CT", "ts": "..." }, ...],
  "cumulative": [{ "t": "18:00", "n": 120 }, ...],
  "lastYearTotal": 980
}
```

### Aggregate queries (D1 / SQLite)
```sql
-- total
SELECT COUNT(*) AS total FROM qsos;
-- per band
SELECT band, COUNT(*) c FROM qsos GROUP BY band ORDER BY c DESC;
-- per operator
SELECT operator, COUNT(*) c FROM qsos GROUP BY operator ORDER BY c DESC;
-- sections worked
SELECT DISTINCT section FROM qsos WHERE section != '';
-- rate last hour (ts stored as epoch seconds; see schema note)
SELECT COUNT(*) FROM qsos WHERE ts_epoch >= strftime('%s','now') - 3600;
-- recent
SELECT call, band, operator, section, ts FROM qsos ORDER BY ts_epoch DESC LIMIT 20;
```

---

## Component 3 — D1 Schema

```sql
CREATE TABLE IF NOT EXISTS qsos (
  id          TEXT PRIMARY KEY,         -- N1MM GUID, lowercased
  call        TEXT NOT NULL,
  band        TEXT NOT NULL,            -- canonical: '20m', '40m', ...
  mode        TEXT,
  operator    TEXT,
  section     TEXT,                     -- ARRL/RAC section, uppercased
  ts          TEXT,                     -- original N1MM timestamp string (UTC)
  ts_epoch    INTEGER,                  -- parsed epoch seconds, for rate/recent queries
  points      INTEGER DEFAULT 0,
  is_original INTEGER DEFAULT 1,
  created_at  INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_qsos_band     ON qsos(band);
CREATE INDEX IF NOT EXISTS idx_qsos_operator ON qsos(operator);
CREATE INDEX IF NOT EXISTS idx_qsos_section  ON qsos(section);
CREATE INDEX IF NOT EXISTS idx_qsos_tsepoch  ON qsos(ts_epoch);

-- optional config (last year total, station class, event start/stop)
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
```

Note: N1MM timestamps are UTC like `2026-06-28 18:43:38`. Parse to `ts_epoch` in the agent (cheaper than doing it in the Worker on every read).

---

## Component 4 — Frontend

Single page (plain HTML+JS is fine; React if you prefer). Polls `/api/stats` every 5–10s and re-renders. Design for a TV across the room: dark background, oversized numbers, high contrast, no scrolling.

Layout suggestion (one screen, no rotation needed):
- **Hero**: giant TOTAL count, with rate/hour and "X of last year" underneath.
- **Per-band**: horizontal bars, band label + count.
- **Per-operator**: ranked bars or a simple leaderboard table (top ~12).
- **Sections grid (v1)**: a fixed grid of all ARRL/RAC sections; worked = bright/filled, unworked = dim. A toggle flips to "needed" (show only unworked).
- **Recent ticker** (bonus): scrolling last-20 calls; flash + chime on a new section.

Use `frontend-design` skill guidance for the visual pass. Keep all polling client-side; the Worker stays cacheable.

### Section list (starter — VERIFY before relying on "needed")
Drop this in as `sections.json`. This is a working list of the standard ARRL/RAC Field Day sections (~83 + DX). **Confirm against the current official ARRL Field Day section list** — Canada and Florida sections have been reorganized over the years. Fastest authoritative source: N1MM's own ARRLFD section table, or the ARRL FD rules packet.

```json
{
  "US": [
    "CT","EMA","ME","NH","RI","VT","WMA",
    "ENY","NLI","NNY","NNJ","SNJ",
    "DE","EPA","MDC","WPA",
    "IL","IN","WI",
    "KY","MI","OH",
    "MN","ND","SD",
    "AR","LA","MS","TN",
    "IA","KS","MO","NE",
    "CO","NM","UT","WY",
    "AK","EWA","ID","MT","OR","WWA",
    "EB","NV","PAC","SCV","SF","SJV","SV",
    "AL","GA","NFL","SFL","WCF","PR","VI",
    "AZ","LAX","ORG","SB","SDG",
    "NTX","OK","STX","WTX",
    "NC","SC","VA","WV"
  ],
  "CANADA": [
    "MAR","NL","QC","ONE","ONN","ONS","GTA","MB","SK","AB","BC","NT"
  ],
  "OTHER": ["DX"]
}
```

---

## N1MM+ configuration checklist (do at the site)
- Config → Configure Ports, Mode Control… → **Broadcast Data** tab.
- Check **Contacts**; set destination to the agent's `IP:12060`.
- Multi-op: also check **All Computers** on ONE networked PC so it forwards the whole network's QSOs to the agent.
- (Bonus) Check **Radio** to enable the "who's on what band now" feature; **Score** if you want N1MM's own point totals.
- Print one received packet in the agent and confirm `<section>` carries the ARRL section.

## Deploy / runbook
1. `wrangler d1 create fieldday` → paste `database_id` into `wrangler.toml`.
2. Apply schema: `wrangler d1 execute fieldday --file=schema.sql`.
3. `wrangler secret put INGEST_SECRET`.
4. `wrangler deploy`.
5. On the mini PC: `INGEST_SECRET=... WORKER_URL=https://... node agent.js`.
6. Dry run with N1MM's `replayer.py` against an old log; watch QSOs land and the page update.
7. **Before Field Day starts**: clear the table (`DELETE FROM qsos;`) so counts start at zero.
8. Put the public page behind a clean hostname (e.g., `fieldday.w4trc.org`) via Pages/Workers routes.

---

## Build order (ship in increments — tell Claude Code to do these in order)
- **Phase 1 (MVP, get this working first):** D1 schema → Worker `/ingest` + `/api/stats` (total, byBand, byOperator, sectionsWorked) → agent (parse + queue + POST) → frontend with hero total, band bars, operator leaderboard, sections grid. This alone meets all four must-haves.
- **Phase 2:** rate/hour, cumulative chart, recent ticker + new-section flash, "sections needed" toggle, pace-vs-last-year.
- **Phase 3:** real ARRL-section choropleth map (convert n1kdo/n1mm_view's BSD-licensed `shapes/` to GeoJSON, fill by worked set) and Radio-packet "on-air now" panel.

Keep Phase 1 deployable on its own. Don't let the map block the must-haves.