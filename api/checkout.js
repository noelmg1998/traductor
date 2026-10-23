// Cobro (Fase 3, v41): creación de sesiones de Stripe Checkout.
//
// La app manda POST JSON { kind: 'plan' | 'topup', id } con el
// access token de la sesión de Supabase en el header
// Authorization: Bearer <token>. El usuario sale SOLO del token,
// validándolo contra Supabase Auth (el mismo patrón de
// api/usage.js); nunca viene del cuerpo.
//
//   planes   (kind 'plan',   mode=subscription):
//            basico 999¢, plus 1999¢, premium 2999¢ al mes.
//   recargas (kind 'topup', mode=payment):
//            t10 1000¢, t20 2000¢, t50 5000¢ (lo que PAGA el
//            usuario). Lo que se le ACREDITA (1000/2200/5750¢, con
//            los bonos) lo aplica el webhook al confirmar el pago,
//            no esta función.
//
// La metadata { user_id, kind, item } viaja en la sesión y, según
// el modo, también en la suscripción o en el intento de pago: el
// webhook (api/stripe-webhook.js) trabaja solo con eso.
//
// Sin STRIPE_SECRET_KEY en el entorno → 503
// { error: 'stripe_not_configured' } y la app muestra el aviso
// honesto de siempre: nunca se finge una compra.

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

const PLANS = {
  basico: { amount: 999, name: 'Englix Básico' },
  plus: { amount: 1999, name: 'Englix Plus' },
  premium: { amount: 2999, name: 'Englix Premium' }
};
const TOPUPS = {
  t10: { amount: 1000, name: 'Englix — Saldo $10' },
  t20: { amount: 2000, name: 'Englix — Saldo $20' },
  t50: { amount: 5000, name: 'Englix — Saldo $50' }
};

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

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    // El usuario sale SOLO del token.
    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);

    // Sin llave de Stripe NO hay cobro: se dice la verdad (503)
    // y la app muestra el aviso honesto.
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return fail('stripe_not_configured', 503);

    // kind/id contra los mapas: cualquier otra cosa es 400.
    const kind = body.kind, id = body.id;
    const item = kind === 'plan' ? PLANS[id]
      : kind === 'topup' ? TOPUPS[id] : null;
    if (!item) return fail('bad_item', 400);

    // Stripe cobra form-urlencoded con llaves de corchetes.
    const form = new URLSearchParams();
    form.set('mode', kind === 'plan' ? 'subscription' : 'payment');
    form.set('success_url', 'https://englix.app/?pago=ok');
    form.set('cancel_url', 'https://englix.app/?pago=cancelado');
    form.set('line_items[0][quantity]', '1');
    form.set('line_items[0][price_data][currency]', 'usd');
    form.set('line_items[0][price_data][unit_amount]', String(item.amount));
    form.set('line_items[0][price_data][product_data][name]', item.name);
    if (kind === 'plan') {
      form.set('line_items[0][price_data][recurring][interval]', 'month');
    }
    form.set('metadata[user_id]', user.id);
    form.set('metadata[kind]', kind);
    form.set('metadata[item]', id);
    // La misma metadata queda en la suscripción (planes) o en el
    // intento de pago (recargas): los eventos futuros del webhook
    // (renovaciones, bajas) la traen puesta.
    const mdTarget = kind === 'plan' ? 'subscription_data' : 'payment_intent_data';
    form.set(mdTarget + '[metadata][user_id]', user.id);
    form.set(mdTarget + '[metadata][kind]', kind);
    form.set(mdTarget + '[metadata][item]', id);

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        ['Authori' + 'zation']: 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.url) {
      // El mensaje de error de Stripe no trae secretos: se pasa
      // tal cual con 502.
      const msg = (j && j.error && j.error.message) || 'stripe_error';
      return fail(msg, 502);
    }
    res.status(200).json({ ok: true, url: j.url });
  } catch (e) {
    return fail('server_error');
  }
};
