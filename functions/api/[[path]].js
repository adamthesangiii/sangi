// Cloudflare Pages Function: jednoduché úložisko dokumentov nad D1.
// GET    /api/all                 -> všetky kolekcie naraz
// GET    /api/:col                -> dokumenty kolekcie
// PUT    /api/:col/:id            -> zapíše celý dokument
// PATCH  /api/:col/:id            -> doplní/zmení polia dokumentu
// DELETE /api/:col/:id            -> zmaže dokument
// Každá požiadavka musí mať hlavičku X-App-Pin zhodnú s premennou APP_PIN.
import { SEED_BLOCKS } from '../../lib/seed.js';

const COLS = ['blocks', 'jobs', 'loads', 'workers'];
const ID_RE = /^[A-Za-z0-9_\-.:@+~]{1,200}$/;
let ready = false;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function init(db) {
  if (ready) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))').run();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM docs WHERE col = 'blocks'").first();
  if (!row || !row.n) {
    const now = Date.now();
    const stmts = SEED_BLOCKS.map(({ id, ...data }) =>
      db.prepare('INSERT OR IGNORE INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?)').bind('blocks', id, JSON.stringify(data), now));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  }
  ready = true;
}

async function list(db, col) {
  const { results } = await db.prepare('SELECT id, data FROM docs WHERE col = ?').bind(col).all();
  return results.map(r => ({ id: r.id, ...JSON.parse(r.data) }));
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Chýba väzba D1 databázy s názvom DB.' }, 500);
  if (!env.APP_PIN) return json({ error: 'Nie je nastavený APP_PIN.' }, 500);
  if (!safeEqual(request.headers.get('x-app-pin'), env.APP_PIN)) return json({ error: 'Nesprávny PIN.' }, 401);

  const db = env.DB;
  await init(db);
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const [col, id] = parts;
  const method = request.method;

  if (method === 'GET' && col === 'all' && !id) {
    const out = {};
    for (const c of COLS) out[c] = await list(db, c);
    return json(out);
  }
  if (!COLS.includes(col)) return json({ error: 'Neznáma kolekcia.' }, 404);
  if (method === 'GET' && !id) return json(await list(db, col));
  if (!id || !ID_RE.test(id)) return json({ error: 'Neplatné ID.' }, 400);

  if (method === 'DELETE') {
    await db.prepare('DELETE FROM docs WHERE col = ? AND id = ?').bind(col, id).run();
    return json({ ok: true });
  }
  if (method === 'PUT' || method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Neplatné dáta.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Neplatné dáta.' }, 400);
    delete body.id;
    let data = body;
    if (method === 'PATCH') {
      const cur = await db.prepare('SELECT data FROM docs WHERE col = ? AND id = ?').bind(col, id).first();
      if (!cur) return json({ error: 'Dokument neexistuje.' }, 404);
      data = { ...JSON.parse(cur.data), ...body };
    }
    const s = JSON.stringify(data);
    if (s.length > 200000) return json({ error: 'Príliš veľký záznam.' }, 413);
    await db.prepare('INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .bind(col, id, s, Date.now()).run();
    return json({ ok: true });
  }
  return json({ error: 'Nepodporovaná metóda.' }, 405);
}
