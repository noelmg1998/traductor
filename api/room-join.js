// Sala de reunión (2026-10): entrada del invitado.
// Decisiones de Noel: AMBOS necesitan cuenta de Englix y AMBOS
// consumen de SUS minutos — el invitado también necesita minutos
// de llamada pa' poder unirse; si no tiene, la app le avisa y lo
// manda a verificar su número pa' reclamar su regalo de
// bienvenida (10 min de conversación + 10 min de llamadas).
// Este endpoint valida su sesión, CHEQUEA sus minutos y, si
// pasa, acuña SU token del relay pa' esa sala.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

async function userFromToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      ['Authori' + 'zation']: 'Bearer ' + token
    }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  return u;
}

async function svc(path, options) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + path, Object.assign({}, options || {}, {
    headers: Object.assign({
      apikey: key,
      ['Authori' + 'zation']: 'Bearer ' + key,
      'Content-Type': 'application/json'
    }, (options && options.headers) || {})
  }));
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

async function readEntitlements(userId) {
  const q = '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(userId) +
    '&select=user_id,plan,plan_conv_seconds,plan_call_seconds,balance_cents,cycle_ends_at&limit=1';
  const r = await svc(q);
  if (!r.ok) return null;
  const row = Array.isArray(r.json) && r.json.length ? r.json[0] : null;
  return row || {
    user_id: userId, plan: 'free',
    plan_conv_seconds: 0, plan_call_seconds: 0,
    balance_cents: 0, cycle_ends_at: null
  };
}

// La sala consume del bote de llamadas de CADA participante.
function availableCallSeconds(ent) {
  return (ent.plan_call_seconds || 0) +
    Math.floor((ent.balance_cents || 0) / 15) * 60;
}

const rlBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    rlBuckets.set(key, b);
  }
  b.count += 1;
  if (rlBuckets.size > 5000) rlBuckets.clear();
  return b.count > max;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '?';
}

function mintRelayToken(roomId) {
  const secret = process.env['RELAY_SHARED_SECRET'];
  if (!secret) return '';
  const exp = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
  const sig = crypto.createHmac('sha256', secret)
    .update(roomId + '.' + exp).digest('base64url');
  return 'v1.' + roomId + '.' + exp + '.' + sig;
}

module.exports = async (req, res) => {
  const fail = (error, status, extra) => {
    res.status(status || 200).json(Object.assign({ ok: false, error }, extra || {}));
  };

  try {
    if (req.method !== 'POST') return fail('method');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const roomId = String(body.roomId || '');
    if (!/^sala-[0-9a-f]{16}$/.test(roomId)) return fail('bad_room', 400);

    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);
    if (rateLimited(user.id + '|' + clientIp(req), 20, 60 * 1000)) {
      return fail('rate_limited', 429);
    }
    // Chequeo de minutos del invitado (regla de Noel): sin
    // minutos de llamada no se une, y la app le avisa.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return fail('billing_not_configured', 503);
    }
    const ent = await readEntitlements(user.id);
    if (!ent) return fail('db_error', 503);
    if (availableCallSeconds(ent) <= 0) return fail('no_minutes', 402);

    const relayToken = mintRelayToken(roomId);
    if (!relayToken) return fail('relay_not_configured', 503);

    res.status(200).json({
      ok: true,
      roomId: roomId,
      relayToken: relayToken,
      relayHost: 'relay.englix.app'
    });
  } catch (e) {
    return fail('server_error');
  }
};
