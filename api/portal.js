// Cobro (v50): portal de facturación de Stripe (Billing Portal).
//
// La app manda POST con el access token de la sesión de Supabase
// en el header Authorization: Bearer <token>. El usuario sale
// SOLO del token, validándolo contra Supabase Auth (el mismo
// patrón de api/usage.js); nunca viene del cuerpo.
//
// Si el usuario ya es cliente de Stripe (su fila de entitlements
// trae stripe_customer_id, puesto por el webhook tras el primer
// cobro), se crea una sesión del Billing Portal — donde puede
// cambiar su tarjeta y ver sus cobros — y se devuelve su URL.
//   · Sin fila o sin cliente → { ok: false, error: 'no_customer' }.
//   · Sin STRIPE_SECRET_KEY  → 503 'payments_not_configured'
//     (la app muestra el aviso honesto; nunca se finge un portal).
//   · Falla de Stripe        → { ok: false,
//     error: 'portal_unavailable' }.
//
// El id de cliente se lee con la llave de servicio y NUNCA sale
// al cliente: solo viaja de aquí a Stripe.

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

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

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method');

    // Sin llave de servicio no se puede leer la fila del usuario.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return fail('billing_not_configured', 503);
    }

    // Sin llave de Stripe NO hay portal: se dice la verdad (503).
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return fail('payments_not_configured', 503);

    // El usuario sale SOLO del token.
    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);

    // El cliente de Stripe del usuario, si ya pagó alguna vez.
    const q = '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=stripe_customer_id&limit=1';
    const r = await svc(q);
    if (!r.ok) return fail('db_error');
    const row = Array.isArray(r.json) && r.json.length ? r.json[0] : null;
    const customer = row && row.stripe_customer_id;
    if (!customer) return fail('no_customer');

    // Sesión del Billing Portal (form-urlencoded, como checkout).
    const form = new URLSearchParams();
    form.set('customer', customer);
    form.set('return_url', 'https://englix.app/');
    const pr = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        ['Authori' + 'zation']: 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const j = await pr.json().catch(() => null);
    if (!pr.ok || !j || !j.url) return fail('portal_unavailable');
    res.status(200).json({ ok: true, url: j.url });
  } catch (e) {
    return fail('server_error');
  }
};
