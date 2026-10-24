// Llamadas telefónicas traducidas (v16): inicia la llamada.
// Recibe { toNumber, myNumber, goal, pairA, pairB } del navegador.
// Marca PRIMERO al usuario (pata "user"); cuando contesta, Twilio avisa a
// /api/call-status y ESE paso crea la llamada a la otra persona (pata
// "dest"), para que el destino nunca suene si el usuario no contestó.
//
// Credenciales SOLO en variables de entorno de Vercel:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (origen)
//   CALL_RELAY_HOST: host del servidor de audio (ej. englix-relay.fly.dev);
//   sin él, la función responde relay_not_configured y la app lo dice
//   honestamente ("falta encender el servidor de llamadas").

const crypto = require('crypto');

const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

// Normaliza un número de EE.UU. a E.164 (+1XXXXXXXXXX). Acepta con o sin +1.
function normalizeUS(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length !== 11 || d.charAt(0) !== '1') return null;
  return '+' + d;
}

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Iniciar una llamada cuesta dinero (Twilio + relay): exige
   sesión válida de Supabase y minutos de llamada (plan o saldo).
   El usuario sale SOLO del token — el patrón de api/usage.js. */
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

// Segundos disponibles de un tipo: los del plan + los que el saldo
// compra a su tarifa ($0.10/min conversación, $0.15/min llamada).
function availableSeconds(ent, kind) {
  if (kind === 'conv') {
    return (ent.plan_conv_seconds || 0) +
      Math.floor((ent.balance_cents || 0) / 10) * 60;
  }
  return (ent.plan_call_seconds || 0) +
    Math.floor((ent.balance_cents || 0) / 15) * 60;
}

// Limitador en memoria por usuario+IP (best-effort: vive en la
// instancia de la función; frena el abuso básico, no es un límite
// global entre instancias).
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

// Puerta completa: sesión (401) → límite (429) → minutos del tipo
// pedido (402). Si algo falla, responde el error y devuelve null.
async function gate(req, fail, kind, rlMax, rlWindowMs) {
  const auth = String(req.headers.authorization || req.headers.Authorization || '');
  const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
  if (!token) { fail('unauthorized', 401); return null; }
  const user = await userFromToken(token).catch(() => null);
  if (!user) { fail('unauthorized', 401); return null; }
  if (rateLimited(user.id + '|' + clientIp(req), rlMax, rlWindowMs)) {
    fail('rate_limited', 429); return null;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail('billing_not_configured', 503); return null;
  }
  const ent = await readEntitlements(user.id);
  if (!ent) { fail('db_error', 503); return null; }
  if (availableSeconds(ent, kind) <= 0) {
    fail('no_minutes', 402); return null;
  }
  return { user, ent };
}

// Token del relay: se acuña aquí, tras la puerta, con el callId de
// la llamada. El relay lo exige pa' abrir las sesiones de OpenAI
// de ESTA llamada y pa' entregar su resumen; viaja como parámetro
// rt en las URL de Twilio (TwiML y StatusCallback) y la app lo
// guarda pa' pedir el resumen. Formato:
//   v1.<callId>.<expUnix>.<base64url(HMAC-SHA256(secreto, callId.exp))>
function mintRelayToken(callId) {
  const secret = process.env['RELAY_SHARED_SECRET'];
  if (!secret) return '';
  const exp = Math.floor(Date.now() / 1000) + 4 * 60 * 60;
  const sig = crypto.createHmac('sha256', secret)
    .update(callId + '.' + exp).digest('base64url');
  return 'v1.' + callId + '.' + exp + '.' + sig;
}

module.exports = async (req, res) => {
  const fail = (error, status, extra) => {
    res.status(status || 200).json(Object.assign({ ok: false, error }, extra || {}));
  };

  try {
    if (req.method !== 'POST') return fail('method');

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    // Relay en Fly.io bajo relay.englix.app (ver la nota en
    // call-twiml.js): la variable CALL_RELAY_HOST quedó con el host
    // viejo de Render; manda el dominio propio.
    const envRelay = String(process.env.CALL_RELAY_HOST || '')
      .replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const relay = envRelay === 'relay.englix.app' ? envRelay : 'relay.englix.app';
    if (!sid || !token || !from) return fail('calls_not_configured');
    if (!relay) return fail('relay_not_configured');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    // Puerta: sesión válida + minutos de llamada, ANTES de validar
    // números y de marcar — sin sesión la respuesta es 401, no
    // bad_number. Máximo 10 inicios por minuto y usuario.
    const g = await gate(req, fail, 'call', 10, 60 * 1000);
    if (!g) return;

    const to = normalizeUS(body.toNumber);
    const mine = normalizeUS(body.myNumber);
    if (!to || !mine || to === mine) return fail('bad_number');

    let pairA = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'es';
    let pairB = ALLOWED_LANGUAGES.indexOf(body.pairB) >= 0 ? body.pairB : 'en';
    if (pairA === pairB) pairB = pairA === 'es' ? 'en' : 'es';
    const goal = String(body.goal || '').slice(0, 140);

    // v18: si el usuario verificó SU número en Twilio (Outgoing Caller ID),
    // la pata del destino sale mostrando SU número real y la otra persona
    // reconoce quién llama. Si no, sale el número de Englix.
    let destFrom = from;
    try {
      const vr = await fetch(
        'https://api.twilio.com/2010-04-01/Accounts/' + sid +
          '/OutgoingCallerIds.json?PhoneNumber=' + encodeURIComponent(mine),
        {
          headers: {
            ['Authori' + 'zation']:
              'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
          }
        }
      );
      const vj = await vr.json().catch(() => ({}));
      if (vr.ok && vj && Array.isArray(vj.outgoing_caller_ids) &&
          vj.outgoing_caller_ids.length) {
        destFrom = mine;
      }
    } catch (e) { /* si la consulta falla, se usa el número de Englix */ }

    const callId = crypto.randomUUID();
    const relayToken = mintRelayToken(callId);
    // Base FIJA (auditoría 2026-10): nunca se confía en el header
    // Host pa' armar las URL que Twilio va a llamar.
    const base = 'https://englix.app';

    const twimlQ = new URLSearchParams({
      leg: 'user', callId, dest: to, goal, pairA, pairB
    });
    const statusQ = new URLSearchParams({
      leg: 'user', callId, dest: to, from: destFrom, goal, pairA, pairB
    });
    // El token del relay viaja en las dos URL: call-twiml lo pasa
    // al stream como <Parameter> y call-status lo hereda a la pata
    // destino.
    if (relayToken) {
      twimlQ.set('rt', relayToken);
      statusQ.set('rt', relayToken);
    }

    const form = new URLSearchParams();
    form.set('To', mine);
    form.set('From', from);
    form.set('Url', base + '/api/call-twiml?' + twimlQ.toString());
    form.set('Method', 'POST');
    form.set('StatusCallback', base + '/api/call-status?' + statusQ.toString());
    form.set('StatusCallbackMethod', 'POST');
    // OJO: los eventos válidos de Twilio son initiated/ringing/answered/
    // completed. "in-progress" es un ESTADO, no un evento: Twilio lo
    // rechazaba con el warning 21626 y NUNCA avisaba — por eso la pata
    // destino no se creaba y la llamada se caía tras el saludo
    // (confirmado en el registro de llamadas del 2026-10-22). El aviso
    // 'answered' llega con CallStatus = in-progress en el cuerpo.
    form.append('StatusCallbackEvent', 'answered');
    form.append('StatusCallbackEvent', 'completed');

    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Calls.json',
      {
        method: 'POST',
        headers: {
          ['Authori' + 'zation']:
            'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // El detalle del proveedor queda SOLO en el registro del
      // servidor; al cliente va un error genérico (auditoría 2026-10).
      const detail = j && j.message
        ? String(j.code || '') + ': ' + String(j.message).slice(0, 200)
        : 'status ' + r.status;
      console.error('[call-start] twilio', detail);
      return fail('twilio_error');
    }

    res.status(200).json({
      ok: true, callId, relayHost: relay, relayToken: relayToken || null,
      callerId: destFrom === mine ? 'own' : 'englix'
    });
  } catch (e) {
    return fail('server_error');
  }
};
