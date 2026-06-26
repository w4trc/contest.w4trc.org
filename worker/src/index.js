import FRONTEND_HTML from './frontend.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/ingest') {
      return handleIngest(request, env);
    }
    if (request.method === 'GET' && pathname === '/api/stats') {
      return handleStats(env);
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return new Response(FRONTEND_HTML, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
};

async function handleIngest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.INGEST_SECRET}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return json({ ok: true, processed: 0 });
  }

  const stmts = [];
  for (const evt of events) {
    if (evt.op === 'upsert' && evt.qso) {
      const q = evt.qso;
      if (!q.id || !q.call || !q.band) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO qsos (id,call,band,mode,operator,section,ts,ts_epoch,points,is_original)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             call=excluded.call, band=excluded.band, mode=excluded.mode,
             operator=excluded.operator, section=excluded.section,
             ts=excluded.ts, ts_epoch=excluded.ts_epoch,
             points=excluded.points, is_original=excluded.is_original`
        ).bind(
          q.id, q.call, q.band,
          q.mode || '', q.operator || '', q.section || '',
          q.ts || '', q.ts_epoch || 0,
          Number(q.points) || 0, q.is_original ? 1 : 0
        )
      );
    } else if (evt.op === 'delete') {
      if (evt.id) {
        stmts.push(env.DB.prepare('DELETE FROM qsos WHERE id = ?').bind(evt.id));
      } else if (evt.call && evt.ts) {
        stmts.push(
          env.DB.prepare('DELETE FROM qsos WHERE call = ? AND ts = ?').bind(evt.call, evt.ts)
        );
      }
    } else if (evt.op === 'radiostate' && evt.radio) {
      const r = evt.radio;
      const val = JSON.stringify({ ...r, updated: new Date().toISOString() });
      stmts.push(
        env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
          .bind('radio:' + r.nr, val)
      );
    }
  }

  if (stmts.length > 0) {
    // D1 batch limit is 100; chunk if needed
    for (let i = 0; i < stmts.length; i += 100) {
      await env.DB.batch(stmts.slice(i, i + 100));
    }
  }

  return json({ ok: true, processed: stmts.length });
}

async function handleStats(env) {
  const [totalRes, bandRes, opRes, sectionRes, rateHourRes, recentRes, rate10Res, cumRes, scoreRes, radiosRes, modeRes] =
    await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS total FROM qsos'),
      env.DB.prepare('SELECT band, COUNT(*) AS c FROM qsos GROUP BY band ORDER BY c DESC'),
      env.DB.prepare('SELECT operator, COUNT(*) AS c FROM qsos GROUP BY operator ORDER BY c DESC'),
      env.DB.prepare("SELECT DISTINCT section FROM qsos WHERE section != '' ORDER BY section"),
      env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM qsos WHERE ts_epoch >= CAST(strftime('%s','now') AS INTEGER) - 3600"
      ),
      env.DB.prepare(
        'SELECT call, band, operator, section, ts FROM qsos ORDER BY ts_epoch DESC LIMIT 20'
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM qsos WHERE ts_epoch >= CAST(strftime('%s','now') AS INTEGER) - 600"
      ),
      env.DB.prepare(
        `SELECT (ts_epoch / 1800) * 1800 AS bucket, COUNT(*) AS n
         FROM qsos WHERE ts_epoch > 0
         GROUP BY bucket ORDER BY bucket`
      ),
      env.DB.prepare('SELECT SUM(points) AS score FROM qsos'),
      env.DB.prepare("SELECT v FROM meta WHERE k LIKE 'radio:%' ORDER BY k"),
      env.DB.prepare('SELECT mode, COUNT(*) AS c FROM qsos GROUP BY mode ORDER BY c DESC'),
    ]);

  // Convert per-bucket counts to running cumulative total
  let running = 0;
  const cumulative = cumRes.results.map(r => {
    running += r.n;
    return { t: r.bucket, n: running };
  });

  const stats = {
    updated: new Date().toISOString(),
    total: totalRes.results[0]?.total ?? 0,
    byBand: bandRes.results.map(r => ({ band: r.band, count: r.c })),
    byOperator: opRes.results.map(r => ({ operator: r.operator, count: r.c })),
    sectionsWorked: sectionRes.results.map(r => r.section).filter(Boolean),
    rateLastHour: rateHourRes.results[0]?.cnt ?? 0,
    rateLast10:   rate10Res.results[0]?.cnt ?? 0,
    score:        scoreRes.results[0]?.score ?? 0,
    recent:       recentRes.results,
    cumulative,
    radios:  radiosRes.results.map(r => JSON.parse(r.v)),
    byMode:  modeRes.results.map(r => ({ mode: r.mode, count: r.c })),
  };

  return new Response(JSON.stringify(stats), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=5',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
