# W4TRC Field Day Live Dashboard

Real-time public dashboard for ARRL Field Day. The local agent listens for [N1MM+](https://n1mmplus.com) UDP broadcast packets, queues contacts to disk, and forwards them to a Cloudflare Worker that stores them in D1 and serves a live web dashboard.

## Architecture

```
N1MM+ logger  ──UDP 12060──▶  agent (Node.js)  ──HTTPS──▶  Cloudflare Worker
                                 │                              │
                             queue.jsonl                     D1 (SQLite)
                             (disk-backed)                      │
                                                         public dashboard
                                                         /api/stats JSON
```

**`agent/`** — Node.js process that runs on the Field Day PC alongside N1MM+.  
**`worker/`** — Cloudflare Worker: ingest endpoint + stats API + single-page dashboard.

## Dashboard features

- Total QSOs, score (1 pt phone / 2 pt CW+digital), rate last hour and last 10 min
- By-band and by-operator breakdowns
- By-mode breakdown
- On Air Now panel (radio number, operator, band, mode, TX indicator)
- Recent QSOs table
- Cumulative QSO chart (SVG, 30-min buckets)
- Leaflet choropleth map of ARRL/RAC sections worked
- Sections grid with flash animation on new sections
- Auto-refreshes every 10 seconds

## Setup

### 1. Cloudflare Worker (one-time)

```bash
cd worker
npm install      # installs wrangler locally
npx wrangler login
```

Create the D1 database:

```bash
npx wrangler d1 create fieldday
```

Copy the `database_id` from the output into `wrangler.toml`.

Apply the schema:

```bash
npx wrangler d1 execute fieldday --file=schema.sql
```

Set the shared ingest secret:

```bash
npx wrangler secret put INGEST_SECRET
```

Deploy:

```bash
npx wrangler deploy
```

### 2. Local agent

```bash
cd agent
npm install
cp .env.example .env
```

Edit `.env`:

```
WORKER_URL=https://w4trc-fieldday.workers.dev   # your Worker URL
INGEST_SECRET=<same secret you set above>
UDP_PORT=12060
```

Start the agent:

```bash
node agent.js
```

### 3. N1MM+ configuration

In N1MM+: **Config → Configure Ports, Mode Control, Winkey, etc. → Broadcast** tab.

Enable **Broadcast** and set the destination to `127.0.0.1:12060`. Enable both **Contact** and **Radio** broadcasts.

## Redeploying the Worker

```bash
cd worker
npx wrangler deploy
```

## Resetting the database

To clear all QSOs between events:

```bash
cd worker
npx wrangler d1 execute fieldday --command="DELETE FROM qsos; DELETE FROM meta;"
```

## File layout

```
contest.w4trc.org/
├── agent/
│   ├── agent.js          # UDP listener, queue manager, HTTPS sender
│   ├── package.json
│   ├── .env.example
│   ├── queue.jsonl        # runtime — gitignored
│   └── cursor.txt         # runtime — gitignored
├── worker/
│   ├── src/
│   │   ├── index.js       # Worker routes: /ingest, /api/stats, /
│   │   └── frontend.html  # Single-page dashboard
│   ├── schema.sql
│   ├── sections.json      # 86 ARRL/RAC sections (authoritative)
│   └── wrangler.toml
└── .gitignore
```

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `WORKER_URL` | agent `.env` | Deployed Worker URL (no trailing slash) |
| `INGEST_SECRET` | agent `.env` + Wrangler secret | Shared bearer token for the `/ingest` endpoint |
| `UDP_PORT` | agent `.env` | N1MM+ broadcast port (default `12060`) |
| `QUEUE_FILE` | agent `.env` | Path to JSONL queue file (default `./queue.jsonl`) |
| `CURSOR_FILE` | agent `.env` | Path to cursor file (default `./cursor.txt`) |

## Notes

- The agent survives restarts: undelivered events persist in `queue.jsonl` and replay from where delivery left off (`cursor.txt`).
- Radio state (On Air Now) is ephemeral — not queued. A restart clears it until N1MM+ sends the next RadioInfo packet.
- N1MM+ sends `<Freq>` in varying units depending on version/rig. The agent auto-detects the unit by trying Hz, 10 Hz, kHz, and MHz and matching against known band edges.
- The dashboard is fully public — no authentication on the read side.
