// Sala de reunión con traducción (2026-10): crea la sala.
// El anfitrión (usuario de Englix con sesión) crea la sala desde la
// app; el servidor acuña el token del relay y devuelve el enlace
// público (englix.app/sala/<roomId>) que el anfitrión comparte.
// El invitado NO necesita cuenta ni app: entra por el enlace, el
// anfitrión lo deja entrar desde la app, y el relay traduce la
// conversación (audio y video) entre los dos navegadores.
//
// Puerta (misma de call-start.js): sesión válida de Supabase +
// minutos de llamada (plan o saldo) — crear una sala cuesta
// minutos igual que una llamada, porque el relay abre las dos
// sesiones de OpenAI en cuanto el invitado entra.

const crypto = require('crypto');

const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

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

// La sala consume del mismo bote que las llamadas telefónicas.
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

// Token del relay: mismo formato que call-start (v1.<id>.<exp>.<sig>).
// El anfitrión lo presenta al relay al registrar la sala; sin ese
// token la sala NO existe pa' el relay y ningún invitado puede
// entrar (esa es la cerradura de la sala).
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

    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);
    if (rateLimited(user.id + '|' + clientIp(req), 10, 60 * 1000)) {
      return fail('rate_limited', 429);
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return fail('billing_not_configured', 503);
    }
    const ent = await readEntitlements(user.id);
    if (!ent) return fail('db_error', 503);
    if (availableCallSeconds(ent) <= 0) return fail('no_minutes', 402);

    // El anfitrión pone SOLO su idioma (decisión de Noel): el del
    // invitado lo elige el invitado al entrar por el enlace, y la
    // pareja se forma sola entre los dos.
    let pairA = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'es';

    const roomId = 'sala-' + crypto.randomBytes(8).toString('hex');
    const relayToken = mintRelayToken(roomId);
    if (!relayToken) return fail('relay_not_configured', 503);

    res.status(200).json({
      ok: true,
      roomId: roomId,
      relayToken: relayToken,
      relayHost: 'relay.englix.app',
      shareUrl: 'https://englix.app/sala/' + roomId,
      pairA: pairA
    });
  } catch (e) {
    return fail('server_error');
  }
};
