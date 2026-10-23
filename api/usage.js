// Cobro (Fase 1-2, v40): puerta de servidor entre la app y las
// cuentas de Englix (planes + saldo en Supabase).
//
// La app manda POST JSON { action } con el access token de la
// sesión de Supabase en el header Authorization: Bearer <token>.
// El usuario NUNCA viene del cuerpo: se deriva del token,
// validándolo contra Supabase Auth (GET /auth/v1/user, el mismo
// mecanismo que usa supabase-js en auth.getUser(token)).
//
// Acciones:
//   { action: 'status' }                 -> la fila de derechos
//                                           del usuario (o el
//                                           default free en ceros).
//   { action: 'authorize', kind }        -> { canStart, source }:
//                                           ¿puede empezar una
//                                           conversación ('conv')
//                                           o una llamada ('call')?
//   { action: 'consume', kind, seconds } -> rpc consume_seconds:
//                                           descuenta del plan y
//                                           luego del saldo.
//
// Variables de entorno (Vercel):
//   SUPABASE_URL, SUPABASE_ANON_KEY: si faltan, se usan los
//     valores PÚBLICOS del proyecto (los mismos que ya viajan en
//     index.html; la llave anon es pública por diseño, protegida
//     por RLS).
//   SUPABASE_SERVICE_ROLE_KEY: la llave de servicio. SIN ella la
//     función responde 503 { error: 'billing_not_configured' } y
//     la app deja pasar (nunca se finge un cobro ni un saldo).

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

function zeroEntitlements(userId) {
  return {
    user_id: userId, plan: 'free',
    plan_conv_seconds: 0, plan_call_seconds: 0,
    balance_cents: 0, cycle_ends_at: null
  };
}

// Valida el access token contra Supabase Auth y devuelve el
// usuario ({ id, email }) o null.
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

// Llamada REST con la llave de servicio (salta RLS: solo el
// servidor la tiene, y el user_id siempre sale del token).
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
  return row || zeroEntitlements(userId);
}

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method');

    // Sin llave de servicio NO hay cobro: se dice la verdad
    // (503) y la app decide dejar pasar sin fingir nada.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return fail('billing_not_configured', 503);
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};
    const action = body.action;
    if (['status', 'authorize', 'consume'].indexOf(action) < 0) {
      return fail('bad_action', 400);
    }

    // El usuario sale SOLO del token.
    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);

    if (action === 'status') {
      const ent = await readEntitlements(user.id);
      if (!ent) return fail('db_error');
      res.status(200).json({ ok: true, entitlements: ent });
      return;
    }

    const kind = body.kind;
    if (kind !== 'conv' && kind !== 'call') return fail('bad_kind', 400);

    if (action === 'authorize') {
      const ent = await readEntitlements(user.id);
      if (!ent) return fail('db_error');
      const planSec = kind === 'conv' ? ent.plan_conv_seconds : ent.plan_call_seconds;
      let source = 'none';
      if (planSec > 0) source = 'plan';
      else if (ent.balance_cents > 0) source = 'balance';
      res.status(200).json({ ok: true, canStart: source !== 'none', source });
      return;
    }

    // action === 'consume'
    const seconds = body.seconds;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      return fail('bad_seconds', 400);
    }
    const r = await svc('/rest/v1/rpc/consume_seconds', {
      method: 'POST',
      body: JSON.stringify({ p_user: user.id, p_kind: kind, p_seconds: seconds })
    });
    if (!r.ok || !r.json) return fail('db_error');
    res.status(200).json(Object.assign({ ok: true }, r.json));
  } catch (e) {
    return fail('server_error');
  }
};
