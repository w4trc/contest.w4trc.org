/**
 * W4TRC Field Day local ingest agent.
 *
 * Listens on UDP 12060 for N1MM+ broadcast packets, parses them, and ships
 * each QSO to the Cloudflare Worker over HTTPS with retry + disk persistence.
 *
 * Config (env vars):
 *   WORKER_URL     – e.g. https://w4trc-fieldday.workers.dev
 *   INGEST_SECRET  – shared secret matching the Worker
 *   UDP_PORT       – default 12060
 *   QUEUE_FILE     – path to queue JSONL (default ./queue.jsonl)
 *   CURSOR_FILE    – path to cursor file (default ./cursor.txt)
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const WORKER_URL    = (process.env.WORKER_URL    || '').replace(/\/$/, '');
const INGEST_SECRET = process.env.INGEST_SECRET  || '';
const UDP_PORT      = Number(process.env.UDP_PORT || 12060);
const QUEUE_FILE    = process.env.QUEUE_FILE  || path.join(__dir, 'queue.jsonl');
const CURSOR_FILE   = process.env.CURSOR_FILE || path.join(__dir, 'cursor.txt');
const BATCH_SIZE    = 20;
const POLL_MS       = 2000;

if (!WORKER_URL)    die('WORKER_URL is required');
if (!INGEST_SECRET) die('INGEST_SECRET is required');

// ── XML parser ──────────────────────────────────────────────────────────────

const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

const BAND_MAP = {
  '1.8':  '160m', '3.5':  '80m',  '5.3':  '60m',  '7':    '40m',
  '10':   '30m',  '14':   '20m',  '18':   '17m',  '21':   '15m',
  '24':   '12m',  '28':   '10m',  '50':   '6m',   '144':  '2m',
  '222':  '1.25m','420':  '70cm',
};

function normBand(b) {
  if (!b) return 'unknown';
  const key = String(b).replace(',', '.').trim();
  return BAND_MAP[key] || key;
}

// N1MM timestamps are UTC: "2026-06-28 18:43:38"
function parseEpoch(ts) {
  if (!ts) return 0;
  const d = new Date(String(ts).trim().replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

function extractContact(node) {
  return {
    id:          String(node.ID || '').toLowerCase(),
    call:        (node.call       || '').toUpperCase(),
    band:        normBand(node.band),
    mode:        (node.mode       || ''),
    operator:    (node.operator   || '').toUpperCase(),
    section:     (node.section    || '').toUpperCase().trim(),
    ts:          (node.timestamp  || ''),
    ts_epoch:    parseEpoch(node.timestamp),
    points:      Number(node.points || 0),
    is_original: String(node.IsOriginal).toLowerCase() === 'true' ? 1 : 0,
  };
}

function handlePacket(buf) {
  const text = buf.toString('utf8');
  // Quick pre-filter: skip non-XML packets (radioinfo, score, etc.)
  if (!text.includes('<contactinfo>') &&
      !text.includes('<contactreplace>') &&
      !text.includes('<contactdelete>')) return null;

  const doc = xml.parse(text);
  if (doc.contactinfo)    return { op: 'upsert', qso: extractContact(doc.contactinfo) };
  if (doc.contactreplace) return { op: 'upsert', qso: extractContact(doc.contactreplace) };
  if (doc.contactdelete) {
    const d = doc.contactdelete;
    return {
      op:   'delete',
      id:   String(d.ID || '').toLowerCase(),
      call: (d.call || '').toUpperCase(),
      ts:   (d.timestamp || ''),
    };
  }
  return null;
}

// ── Disk-backed queue ────────────────────────────────────────────────────────
// queue.jsonl  – append-only; one JSON event per line
// cursor.txt   – number of lines already successfully sent

function readCursor() {
  try { return parseInt(fs.readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || 0; }
  catch { return 0; }
}

function writeCursor(n) {
  fs.writeFileSync(CURSOR_FILE + '.tmp', String(n), 'utf8');
  fs.renameSync(CURSOR_FILE + '.tmp', CURSOR_FILE); // atomic on same FS
}

function appendQueue(event) {
  fs.appendFileSync(QUEUE_FILE, JSON.stringify(event) + '\n', 'utf8');
}

function readPending() {
  try {
    const cursor = readCursor();
    const lines  = fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
    return { cursor, pending: lines.slice(cursor).map(l => JSON.parse(l)) };
  } catch {
    return { cursor: 0, pending: [] };
  }
}

function enqueue(event) {
  appendQueue(event);
  // Kick the sender so new events go out fast
  setImmediate(drainOnce);
}

// ── Sender ───────────────────────────────────────────────────────────────────

let backoffMs  = 1000;
let draining   = false;

async function drainOnce() {
  if (draining) return;
  draining = true;
  try {
    await _drain();
  } finally {
    draining = false;
  }
}

async function _drain() {
  const { cursor, pending } = readPending();
  if (pending.length === 0) return;

  const batch = pending.slice(0, BATCH_SIZE);
  try {
    const res = await fetch(WORKER_URL + '/ingest', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + INGEST_SECRET,
      },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('[ingest] HTTP', res.status, txt.slice(0, 120));
      scheduleRetry();
      return;
    }

    const newCursor = cursor + batch.length;
    writeCursor(newCursor);
    backoffMs = 1000;
    console.log('[ingest] sent', batch.length, 'events; cursor =', newCursor);

    // More items waiting — drain immediately without waiting for poll
    if (pending.length > BATCH_SIZE) setImmediate(drainOnce);

  } catch (err) {
    console.error('[ingest] send error:', err.message);
    scheduleRetry();
  }
}

function scheduleRetry() {
  backoffMs = Math.min(backoffMs * 2, 30_000);
  console.log('[ingest] retry in', backoffMs, 'ms');
  setTimeout(drainOnce, backoffMs);
}

// Regular poll — catches anything that arrived while a retry was in flight
setInterval(drainOnce, POLL_MS);

// ── UDP socket ───────────────────────────────────────────────────────────────

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', err => {
  console.error('[udp] socket error:', err.message);
});

sock.on('message', (msg, rinfo) => {
  try {
    const evt = handlePacket(msg);
    if (!evt) return;
    enqueue(evt);
    if (evt.op === 'upsert') {
      const q = evt.qso;
      console.log('[rx] upsert', q.call, q.band, q.section || '-', 'op=' + q.operator);
    } else {
      console.log('[rx] delete', evt.id || evt.call);
    }
  } catch (err) {
    console.error('[rx] parse error:', err.message);
    // Print first 300 chars of the bad packet for on-site diagnosis
    console.error('[rx] packet preview:', msg.toString('utf8').slice(0, 300));
  }
});

sock.bind(UDP_PORT, '0.0.0.0', () => {
  console.log('W4TRC Field Day agent started');
  console.log('  UDP port    :', UDP_PORT);
  console.log('  Worker URL  :', WORKER_URL);
  console.log('  Queue file  :', QUEUE_FILE);
  // Drain anything left in the queue from before a restart
  drainOnce();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error('FATAL:', msg);
  process.exit(1);
}
