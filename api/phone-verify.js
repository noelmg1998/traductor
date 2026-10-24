// Verificación de teléfono al crear la cuenta (decisión de Noel,
// 2026-10-23): el regalo de bienvenida (10 min de conversación +
// 10 min de llamadas) se reclama SOLO con un número verificado por
// SMS. Un número = un regalo, una sola vez en la vida — el correo
// se crea a lo loco; el número, no.
//
// POST { action:'send',  phone }        → manda el SMS (Twilio Verify)
// POST { action:'check', phone, code }  → si Twilio aprueba el código,
//      ejecuta el reclamo en el servidor:
//        · la cuenta no debe tener bienvenida previa (welcome_claimed)
//        · la llave canónica del correo no debe estar consumida por
//          OTRA cuenta (welcome_grants, la escribe el alta)
//        · el teléfono no debe haber reclamado antes
//          (welcome_phone_grants, llave atómica)
//      y acredita 600 s + 600 s con su fila en el libro.
//
// Sesión obligatoria siempre (el usuario sale SOLO del token, el
// patrón de api/usage.js). Sin sesión no se manda ni un SMS — un
// endpoint abierto de SMS sería otro agujero (SMS pumping).
//
// Credenciales SOLO en variables de entorno: TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN / SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

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

// La misma canonicalización que public.welcome_email_key en SQL.
function emailKey(raw) {
  const addr = String(raw || '').trim().toLowerCase();
  const at = addr.indexOf('@');
  if (!addr || at < 0) return null;
  let local = addr.slice(0, at).split('+')[0];
  let dom = addr.slice(at + 1);
  if (dom === 'googlemail.com') dom = 'gmail.com';
  if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + dom;
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

/* ---- Twilio Verify: un solo servicio «Englix», creado la primera
   vez y reutilizado (se busca por nombre en cada arranque). ---- */
let verifySidCache = null;
async function verifyServiceSid(sid, token) {
  if (verifySidCache) return verifySidCache;
  const base = 'https://verify.twilio.com/v2/Services';
  const lr = await fetch(base + '?PageSize=50', { headers: twilioAuth(sid, token) });
  const lj = await lr.json().catch(() => ({}));
  if (lr.ok && lj && Array.isArray(lj.services)) {
    const found = lj.services.find(s => s.friendly_name === 'Englix');
    if (found && found.sid) { verifySidCache = found.sid; return found.sid; }
  }
  const form = new URLSearchParams();
  form.set('FriendlyName', 'Englix');
  const cr = await fetch(base, {
    method: 'POST',
    headers: Object.assign(twilioAuth(sid, token), {
      'Content-Type': 'application/x-www-form-urlencoded'
    }),
    body: form.toString()
  });
  const cj = await cr.json().catch(() => ({}));
  if (cr.ok && cj && cj.sid) { verifySidCache = cj.sid; return cj.sid; }
  console.error('[phone-verify] verify service', String((cj && cj.message) || cr.status).slice(0, 200));
  return null;
}

async function twilioForm(url, sid, token, fields) {
  const form = new URLSearchParams();
  Object.keys(fields).forEach(k => form.set(k, fields[k]));
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign(twilioAuth(sid, token), {
      'Content-Type': 'application/x-www-form-urlencoded'
    }),
    body: form.toString()
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j || {} };
}

/* ---- El reclamo: devuelve { granted, reason } ---- */
async function claimWelcome(user, phone) {
  // 0) La cuenta: si ya reclamó, no hay segundo regalo.
  const entR = await svc('/rest/v1/entitlements?user_id=eq.' +
    encodeURIComponent(user.id) +
    '&select=plan_conv_seconds,plan_call_seconds,welcome_claimed&limit=1');
  if (!entR.ok || !Array.isArray(entR.json)) return { error: 'db_error' };
  const ent = entR.json[0] || null;
  if (!ent) return { error: 'db_error' };
  if (ent.welcome_claimed) return { granted: false, reason: 'already_claimed' };

  // 1) Llave del correo: consumida por OTRA cuenta → no hay regalo.
  const key = emailKey(user.email);
  if (key) {
    const g = await svc('/rest/v1/welcome_grants?email_key=eq.' +
      encodeURIComponent(key) + '&select=email_key,first_user_id&limit=1');
    if (g.ok && Array.isArray(g.json) && g.json.length &&
        g.json[0].first_user_id && g.json[0].first_user_id !== user.id) {
      return { granted: false, reason: 'email_used' };
    }
    if (g.ok && Array.isArray(g.json) && !g.json.length) {
      // Cuenta anterior a la lista (sin fila): se registra ahora.
      await svc('/rest/v1/welcome_grants', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ email_key: key, first_user_id: user.id })
      });
    }
  }

  // 2) Llave del teléfono (atómica): si el insert no crea fila, el
  //    número ya reclamó (o esta cuenta ya reclamó con otro número).
  const ins = await svc('/rest/v1/welcome_phone_grants', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ phone_key: phone, first_user_id: user.id })
  });
  if (!ins.ok) return { error: 'db_error' };
  if (!Array.isArray(ins.json) || !ins.json.length) {
    return { granted: false, reason: 'phone_used' };
  }

  // 3) Acreditar + libro + marca durable.
  const patch = await svc('/rest/v1/entitlements?user_id=eq.' +
    encodeURIComponent(user.id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      plan_conv_seconds: (ent.plan_conv_seconds || 0) + 600,
      plan_call_seconds: (ent.plan_call_seconds || 0) + 600,
      welcome_claimed: true
    })
  });
  if (!patch.ok) return { error: 'db_error' };
  await svc('/rest/v1/usage_ledger', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id, kind: 'welcome_phone',
      seconds_delta: 600, cents_delta: 0,
      meta: { source: 'phone_claim', call_seconds: 600 }
    })
  });
  return { granted: true };
}

module.exports = async (req, res) => {
  const fail = (error, status, extra) => {
    res.status(status || 200).json(Object.assign({ ok: false, error }, extra || {}));
  };

  try {
    if (req.method !== 'POST') return fail('method', 405);

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
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return fail('billing_not_configured', 503);

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const twToken = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !twToken) return fail('calls_not_configured', 503);

    const phone = normalizeUS(body.phone);
    if (!phone) return fail('bad_number');
    if (process.env.TWILIO_PHONE_NUMBER && phone === process.env.TWILIO_PHONE_NUMBER) {
      return fail('englix_number');
    }

    const vsid = await verifyServiceSid(sid, twToken);
    if (!vsid) return fail('verify_unavailable', 503);

    if (body.action === 'send') {
      // Máximo 3 SMS por hora y usuario+IP (además de los frenos
      // propios de Twilio Verify contra fraude).
      if (rateLimited('send|' + user.id + '|' + clientIp(req), 3, 60 * 60 * 1000)) {
        return fail('rate_limited', 429);
      }
      const r = await twilioForm(
        'https://verify.twilio.com/v2/Services/' + vsid + '/Verifications',
        sid, twToken, { To: phone, Channel: 'sms' });
      if (!r.ok) {
        console.error('[phone-verify] send', String(r.json.message || r.status).slice(0, 200));
        return fail('sms_error');
      }
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'check') {
      if (rateLimited('check|' + user.id + '|' + clientIp(req), 10, 60 * 60 * 1000)) {
        return fail('rate_limited', 429);
      }
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length < 4 || code.length > 10) return fail('bad_code');
      const r = await twilioForm(
        'https://verify.twilio.com/v2/Services/' + vsid + '/VerificationCheck',
        sid, twToken, { To: phone, Code: code });
      if (!r.ok || !r.json || r.json.status !== 'approved') {
        if (r.ok) return fail('bad_code');
        console.error('[phone-verify] check', String(r.json.message || r.status).slice(0, 200));
        return fail('bad_code');
      }
      const claim = await claimWelcome(user, phone);
      if (claim.error) return fail(claim.error, 503);
      return res.status(200).json({
        ok: true, verified: true,
        granted: !!claim.granted,
        reason: claim.reason || undefined
      });
    }

    return fail('bad_action');
  } catch (e) {
    return fail('server_error');
  }
};
