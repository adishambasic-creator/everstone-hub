// EverStone Hub — reminder & sync service (Cloudflare Worker)
// Bindings needed:  KV namespace bound as HUB,  secret ACCESS_KEY
// Optional text var: CONTACT  (your app URL, e.g. https://yourname.github.io/everstone-hub/)
// Cron trigger:      */15 * * * *

const te = new TextEncoder();

/* ---------- helpers ---------- */
const b64u = {
  enc(buf) {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
};
function concat(...arrs) {
  const len = arrs.reduce((a, b) => a + b.length, 0); const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function authorized(req, env) {
  const h = req.headers.get('Authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!env.ACCESS_KEY || !key || key.length !== env.ACCESS_KEY.length) return false;
  let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ env.ACCESS_KEY.charCodeAt(i);
  return diff === 0;
}

/* ---------- web push (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
async function encryptPayload(sub, text) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPub.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPub.length; header.set(asPub, 21);
  return concat(header, ct);
}
async function getVapid(env) {
  let v = await env.HUB.get('vapid', { type: 'json' });
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    await env.HUB.put('vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidHeader(endpoint, v, env) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.CONTACT || 'https://github.com' })));
  const unsigned = head + '.' + claims;
  const jwk = { ...v.jwk }; delete jwk.key_ops;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${v.pub}`;
}
async function sendPush(env, v, sub, msg) {
  const body = await encryptPayload(sub, JSON.stringify(msg));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, v, env),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '86400', Urgency: 'high'
    },
    body
  });
  return res.status;
}
async function sendToAll(env, msgs) {
  const subs = (await env.HUB.get('subs', { type: 'json' })) || [];
  if (!subs.length || !msgs.length) return { sent: 0, failed: 0, devices: subs.length };
  const v = await getVapid(env);
  let sent = 0, failed = 0; const dead = new Set();
  for (const s of subs) for (const m of msgs) {
    try {
      const st = await sendPush(env, v, s.subscription, m);
      if (st >= 200 && st < 300) sent++; else { failed++; if (st === 404 || st === 410) dead.add(s.subscription.endpoint); }
    } catch (e) { failed++; }
  }
  if (dead.size) await env.HUB.put('subs', JSON.stringify(subs.filter(s => !dead.has(s.subscription.endpoint))));
  return { sent, failed, devices: subs.length - dead.size };
}

/* ---------- reminders ---------- */
function nowIn(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute };
}
const dayIdx = d => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 864e5; };
const hm = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fmtTime = t => { let m = hm(t), h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0'); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${mm} ${ap}`; };
const catName = c => c === 'Real Estate' ? 'Realtor' : 'EverStone';

function buildReminders(st, now, sent) {
  const n = Object.assign({ enabled: true, digest: true, digestTime: '07:30', extras: true, tomorrow: true, lead: 0 }, (st.meta && st.meta.notify) || {});
  if (n.enabled === false) return [];
  const out = []; const today = now.date; const nowAbs = dayIdx(today) * 1440 + now.mins;
  const open = (st.tasks || []).filter(t => !t.done && t.title);
  // daily summary
  if (n.digest) {
    const dt = hm(n.digestTime), key = 'digest:' + today;
    if (now.mins >= dt && now.mins < dt + 60 && !sent[key]) {
      sent[key] = Date.now();
      const over = open.filter(t => t.due && t.due < today), due = open.filter(t => t.due === today);
      const tmr = open.filter(t => t.due && dayIdx(t.due) === dayIdx(today) + 1);
      const ev = n.extras ? (st.agenda || []).filter(a => a.date === today) : [];
      const lines = [];
      over.forEach(t => lines.push('⚠️ Overdue: ' + t.title));
      due.forEach(t => lines.push('• ' + t.title + (t.time ? ' (' + fmtTime(t.time) + ')' : '')));
      ev.forEach(a => lines.push('• ' + a.title + (a.sub ? ' — ' + a.sub : '')));
      if (n.tomorrow && tmr.length) lines.push(`Tomorrow: ${tmr.length} task${tmr.length > 1 ? 's' : ''}`);
      const count = over.length + due.length + ev.length;
      if (count || (n.tomorrow && tmr.length)) {
        out.push({ title: count ? `Today: ${count} thing${count > 1 ? 's' : ''} on your list` : 'Coming up tomorrow', body: lines.slice(0, 8).join('\n'), tag: 'digest', url: './#dashboard' });
      }
    }
  }
  // timed task reminders
  open.filter(t => t.due && t.time).forEach(t => {
    const target = dayIdx(t.due) * 1440 + hm(t.time) - (+n.lead || 0);
    const key = `t:${t.id}:${t.due}:${t.time}:${n.lead || 0}`;
    if (nowAbs >= target && nowAbs < target + 120 && !sent[key]) {
      sent[key] = Date.now();
      const lead = +n.lead || 0;
      out.push({ title: t.title, body: `${catName(t.cat)} task · ${lead ? 'in ' + (lead >= 60 ? lead / 60 + ' hr' : lead + ' min') + ' — ' : 'due '}${fmtTime(t.time)}${t.notes ? '\n' + t.notes : ''}`, tag: 'task-' + t.id, url: './#tasks' });
    }
  });
  return out;
}
async function runReminders(env) {
  const rec = await env.HUB.get('state', { type: 'json' });
  if (!rec || !rec.state) return;
  const subs = (await env.HUB.get('subs', { type: 'json' })) || [];
  if (!subs.length) return;
  const st = rec.state; const tz = (st.meta && st.meta.tz) || 'America/Chicago';
  const sent = (await env.HUB.get('sent', { type: 'json' })) || {};
  const before = JSON.stringify(sent);
  const msgs = buildReminders(st, nowIn(tz), sent);
  for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 4 * 864e5) delete sent[k];
  if (JSON.stringify(sent) !== before) await env.HUB.put('sent', JSON.stringify(sent));
  if (msgs.length) await sendToAll(env, msgs);
}

/* ---------- HTTP API ---------- */
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/health') return json({ ok: true, service: 'EverStone Hub', kv: !!env.HUB, key: !!env.ACCESS_KEY });
    if (!env.HUB) return json({ error: 'KV namespace not bound as HUB' }, 500);
    if (!env.ACCESS_KEY) return json({ error: 'ACCESS_KEY secret not set' }, 500);
    if (!authorized(req, env)) return json({ error: 'Wrong access key' }, 401);
    try {
      if (path === '/state' && req.method === 'GET') {
        return json((await env.HUB.get('state', { type: 'json' })) || { state: null, version: 0 });
      }
      if (path === '/state' && req.method === 'PUT') {
        const body = await req.json();
        if (!body || typeof body.state !== 'object' || !Array.isArray(body.state.tasks)) return json({ error: 'Bad state' }, 400);
        const rec = { state: body.state, version: Date.now(), updated: new Date().toISOString() };
        await env.HUB.put('state', JSON.stringify(rec));
        return json({ version: rec.version });
      }
      if (path === '/vapid') return json({ publicKey: (await getVapid(env)).pub });
      if (path === '/subscribe' && req.method === 'POST') {
        const { subscription, label } = await req.json();
        if (!subscription || !subscription.endpoint || !subscription.keys) return json({ error: 'Bad subscription' }, 400);
        const subs = ((await env.HUB.get('subs', { type: 'json' })) || []).filter(s => s.subscription.endpoint !== subscription.endpoint);
        subs.push({ subscription, label: String(label || 'Device').slice(0, 60), added: new Date().toISOString() });
        await env.HUB.put('subs', JSON.stringify(subs.slice(-10)));
        return json({ ok: true, devices: subs.length });
      }
      if (path === '/unsubscribe' && req.method === 'POST') {
        const { endpoint } = await req.json();
        const subs = ((await env.HUB.get('subs', { type: 'json' })) || []).filter(s => s.subscription.endpoint !== endpoint);
        await env.HUB.put('subs', JSON.stringify(subs));
        return json({ ok: true, devices: subs.length });
      }
      if (path === '/devices') {
        const subs = (await env.HUB.get('subs', { type: 'json' })) || [];
        return json({ devices: subs.map(s => ({ label: s.label, added: s.added })) });
      }
      if (path === '/test' && req.method === 'POST') {
        return json(await sendToAll(env, [{ title: 'EverStone Hub', body: 'Notifications are working. You’ll get your daily summary and task reminders here.', tag: 'test', url: './#dashboard' }]));
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  }
};
