// Llamadas telefónicas (v18): verificación del número del usuario en Twilio.
// Si el usuario verifica SU número una sola vez (Outgoing Caller ID), las
// llamadas de Englix pueden salir mostrando SU número real en vez del
// número de Englix, y la otra persona reconoce quién llama.
//
// POST { myNumber } →
//   { ok:true, alreadyVerified:true }   si ya estaba verificado; o
//   { ok:true, code:"123456" }          Twilio llama AHORA MISMO a ese
//   número y la voz automática pide marcar ese código en el teclado de
//   la llamada. La app lo muestra grande antes de que suene.
//
// Credenciales SOLO en variables de entorno: TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN.

function normalizeUS(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length !== 11 || d.charAt(0) !== '1') return null;
  return '+' + d;
}

function twilioAuth(sid, token) {
  return {
    ['Authori' + 'zation']:
      'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
  };
}

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Disparar la llamada de validación de Twilio cuesta dinero: exige
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

    // Puerta: sesión válida + minutos de llamada, y máximo 3
    // llamadas de validación por hora y usuario, ANTES de Twilio.
    const g = await gate(req, fail, 'call', 3, 60 * 60 * 1000);
    if (!g) return;

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return fail('calls_not_configured');

    const mine = normalizeUS(body.myNumber);
    if (!mine) return fail('bad_number');
    // El número de Englix no se puede "verificar" como número del usuario.
    if (process.env.TWILIO_PHONE_NUMBER && mine === process.env.TWILIO_PHONE_NUMBER) {
      return fail('englix_number');
    }

    const base = 'https://api.twilio.com/2010-04-01/Accounts/' + sid;

    // ¿Ya está verificado? Entonces no hace falta la llamada de validación.
    const lr = await fetch(
      base + '/OutgoingCallerIds.json?PhoneNumber=' + encodeURIComponent(mine),
      { headers: twilioAuth(sid, token) }
    );
    const lj = await lr.json().catch(() => ({}));
    if (lr.ok && lj && Array.isArray(lj.outgoing_caller_ids) &&
        lj.outgoing_caller_ids.length) {
      return res.status(200).json({ ok: true, alreadyVerified: true });
    }

    const form = new URLSearchParams();
    form.set('PhoneNumber', mine);
    form.set('FriendlyName', 'Englix');
    const r = await fetch(base + '/OutgoingCallerIds.json', {
      method: 'POST',
      headers: Object.assign(twilioAuth(sid, token), {
        'Content-Type': 'application/x-www-form-urlencoded'
      }),
      body: form.toString()
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || !j.validation_code) {
      // El detalle del proveedor queda SOLO en el registro del
      // servidor; al cliente va un error genérico (auditoría 2026-10).
      const detail = j && j.message
        ? String(j.code || '') + ': ' + String(j.message).slice(0, 200)
        : 'status ' + r.status;
      console.error('[call-verify-start] twilio', detail);
      return fail('twilio_error');
    }

    res.status(200).json({ ok: true, code: String(j.validation_code) });
  } catch (e) {
    return fail('server_error');
  }
};
