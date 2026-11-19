// Cloudflare Pages Function: úložisko dokumentov nad D1 s dvomi rolami.
//   owner  – PIN v premennej OWNER_PIN (alebo APP_PIN): vidí a mení všetko
//   worker – PIN v premennej WORKER_PIN: len zápis nakládok, žiadne čísla firmy
// GET    /api/me            -> { role }
// GET    /api/all           -> dáta (pre worker obmedzené)
// PUT    /api/:col/:id      -> zapíše celý dokument
// PATCH  /api/:col/:id      -> doplní/zmení polia
// DELETE /api/:col/:id      -> zmaže dokument
import { SEED_BLOCKS } from '../../lib/seed.js';

const COLS = ['blocks', 'jobs', 'loads', 'workers'];
const ID_RE = /^[A-Za-z0-9_\-.:@+~]{1,200}$/;
const WORKER_EDIT_MS = 24 * 3600 * 1000;      // pracovník môže opraviť nakládku do 24 h
const LOCK_MAX = 10, LOCK_MS = 15 * 60 * 1000; // 10 zlých PIN-ov za 15 min = blokovanie
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
  await db.prepare('CREATE TABLE IF NOT EXISTS auth_fail (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL)').run();
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
async function getDoc(db, col, id) {
  const r = await db.prepare('SELECT data FROM docs WHERE col = ? AND id = ?').bind(col, id).first();
  return r ? JSON.parse(r.data) : null;
}
async function putDoc(db, col, id, data) {
  const s = JSON.stringify(data);
  if (s.length > 200000) return json({ error: 'Príliš veľký záznam.' }, 413);
  await db.prepare('INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(col, id, s, Date.now()).run();
  return json({ ok: true });
}

async function authenticate(request, env, db) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const fail = await db.prepare('SELECT n, first FROM auth_fail WHERE ip = ?').bind(ip).first();
  if (fail && fail.n >= LOCK_MAX && now - fail.first < LOCK_MS) return { blocked: true };
  const pin = request.headers.get('x-app-pin') || '';
  const ownerPin = env.OWNER_PIN || env.APP_PIN;
  let role = null;
  if (pin && ownerPin && safeEqual(pin, ownerPin)) role = 'owner';
  else if (pin && env.WORKER_PIN && safeEqual(pin, env.WORKER_PIN)) role = 'worker';
  if (!role) {
    if (pin) {
      if (!fail || now - fail.first >= LOCK_MS) await db.prepare('INSERT OR REPLACE INTO auth_fail (ip, n, first) VALUES (?, 1, ?)').bind(ip, now).run();
      else await db.prepare('UPDATE auth_fail SET n = n + 1 WHERE ip = ?').bind(ip).run();
    }
    return { role: null };
  }
  if (fail) await db.prepare('DELETE FROM auth_fail WHERE ip = ?').bind(ip).run();
  return { role };
}

// Čo uvidí pracovník: aktívne bloky, otvorené zákazky bez čísel, mená, svoje čerstvé nakládky.
async function workerView(db) {
  const since = Date.now() - WORKER_EDIT_MS;
  const blocks = (await list(db, 'blocks')).filter(b => b.active !== false);
  const jobs = (await list(db, 'jobs')).filter(j => j.status !== 'done')
    .map(({ id, company, name, customer, place, status }) => ({ id, company, name, customer, place, status }));
  const workers = await list(db, 'workers');
  const loads = (await list(db, 'loads')).filter(l => (l.createdAt || l.at || 0) >= since);
  return { blocks, jobs, loads, workers };
}

async function workerWrite(db, method, col, id, body) {
  const now = Date.now();
  if (col === 'loads') {
    const cur = await getDoc(db, 'loads', id);
    if (cur && now - (cur.createdAt || 0) > WORKER_EDIT_MS) return json({ error: 'Staršiu nakládku môže upraviť len majiteľ.' }, 403);
    if (method === 'DELETE') {
      await db.prepare("DELETE FROM docs WHERE col = 'loads' AND id = ?").bind(id).run();
      return json({ ok: true });
    }
    const data = method === 'PATCH' ? { ...(cur || {}), ...body } : body;
    data.createdAt = cur ? cur.createdAt : now;
    if (cur && cur.createdBy) data.createdBy = cur.createdBy;
    if (!cur) data.createdBy = 'worker';
    return putDoc(db, 'loads', id, data);
  }
  if (col === 'jobs') {
    const cur = await getDoc(db, 'jobs', id);
    if (!cur && method === 'PUT') {
      const { company, name, customer, place, contact, note } = body;
      if (!name || !['redirock', 'zemkop'].includes(company)) return json({ error: 'Neplatná zákazka.' }, 400);
      return putDoc(db, 'jobs', id, { company, name, customer: customer || '', place: place || '', contact: contact || '', note: note || '', status: 'active', plan: {}, createdAt: now, updatedAt: now, createdBy: 'worker' });
    }
    if (cur && method === 'PATCH') {
      const keys = Object.keys(body);
      const ok = keys.every(k => k === 'updatedAt' || (k === 'status' && body.status === 'active' && cur.status === 'planned'));
      if (!ok) return json({ error: 'Zákazku môže upraviť len majiteľ.' }, 403);
      return putDoc(db, 'jobs', id, { ...cur, ...(body.status ? { status: 'active' } : {}), updatedAt: now });
    }
    return json({ error: 'Zákazku môže upraviť len majiteľ.' }, 403);
  }
  if (col === 'workers' && method === 'PUT') {
    if (await getDoc(db, 'workers', id)) return json({ error: 'Len majiteľ.' }, 403);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return json({ error: 'Chýba meno.' }, 400);
    return putDoc(db, 'workers', id, { name, active: true, createdAt: now });
  }
  return json({ error: 'Na túto zmenu nemáte oprávnenie.' }, 403);
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: 'Chýba väzba D1 databázy s názvom DB.' }, 500);
  if (!(env.OWNER_PIN || env.APP_PIN)) return json({ error: 'Nie je nastavený OWNER_PIN (alebo APP_PIN).' }, 500);
  const db = env.DB;
  await init(db);

  const auth = await authenticate(request, env, db);
  if (auth.blocked) return json({ error: 'Príliš veľa nesprávnych pokusov. Skúste to o 15 minút.' }, 429);
  if (!auth.role) return json({ error: 'Nesprávny PIN.' }, 401);
  const role = auth.role;

  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const [col, id] = parts;
  const method = request.method;

  if (method === 'GET' && col === 'me' && !id) return json({ role });
  if (method === 'GET' && col === 'all' && !id) {
    if (role === 'worker') return json(await workerView(db));
    const out = {};
    for (const c of COLS) out[c] = await list(db, c);
    return json(out);
  }
  if (role === 'worker' && method === 'GET') return json({ error: 'Len majiteľ.' }, 403);
  if (!COLS.includes(col)) return json({ error: 'Neznáma kolekcia.' }, 404);
  if (method === 'GET' && !id) return json(await list(db, col));
  if (!id || !ID_RE.test(id)) return json({ error: 'Neplatné ID.' }, 400);
  if (!['PUT', 'PATCH', 'DELETE'].includes(method)) return json({ error: 'Nepodporovaná metóda.' }, 405);

  let body = {};
  if (method !== 'DELETE') {
    try { body = await request.json(); } catch { return json({ error: 'Neplatné dáta.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Neplatné dáta.' }, 400);
    delete body.id;
  }
  if (role === 'worker') return workerWrite(db, method, col, id, body);

  if (method === 'DELETE') {
    await db.prepare('DELETE FROM docs WHERE col = ? AND id = ?').bind(col, id).run();
    return json({ ok: true });
  }
  let data = body;
  if (method === 'PATCH') {
    const cur = await getDoc(db, col, id);
    if (!cur) return json({ error: 'Dokument neexistuje.' }, 404);
    data = { ...cur, ...body };
  }
  return putDoc(db, col, id, data);
}
