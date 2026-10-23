// Cobro (Fase 3, v41): webhook de Stripe. Aquí se confirma el
// dinero: SOLO un evento con firma válida mueve planes o saldo.
//
// Verificación de firma MANUAL (sin SDK, con node:crypto): el
// header 'stripe-signature' trae t=<timestamp> y v1=<hmac>; la
// firma válida es HMAC_SHA256(secreto, "<t>.<cuerpo crudo>") en
// hex, comparada en tiempo constante y con tolerancia de 5 min
// pa' el reloj. Por eso el cuerpo se lee CRUDO de la petición
// (ver el config al final: bodyParser apagado) — un solo byte
// distinto y la firma no cuadra.
//
// Eventos:
//   checkout.session.completed → con la metadata de la sesión:
//     recarga = rpc credit_balance con el mapa de CRÉDITO (con
//     bonos); plan = rpc apply_plan con el fin de periodo leído
//     de la suscripción en la API de Stripe.
//   invoice.paid con billing_reason 'subscription_cycle' →
//     renovación del ciclo: apply_plan con el plan guardado y el
//     nuevo fin de periodo.
//   customer.subscription.deleted → baja: apply_plan 'free'.
//
// Idempotencia (Fase 3b): tras verificar la firma, el handler
// RECLAMA el evento en la tabla stripe_events (insert con
// ignore-duplicates sobre el event_id, llave primaria). Si el
// reclamo sale vacío, Stripe ya entregó ese evento antes: se
// responde 200 {received, duplicate:true} SIN procesar. Si el
// reclamo mismo falla (red/base de datos), se responde 500 pa'
// que Stripe reintente. Y si ya reclamado el procesamiento
// falla, se BORRA el reclamo antes del 500, pa' que el reintento
// pueda reclamarlo de nuevo. La tabla la crea
// supabase-stripe-events.sql (aplicarla antes de activar las
// llaves). Requiere esa tabla: sin ella no hay reclamo posible
// y todo evento responde 500 (nada se aplica a ciegas).
//
// Sin STRIPE_WEBHOOK_SECRET (o sin la llave de servicio de
// Supabase) → 503. Firma mala → 400. Fallo de una RPC → 500 (pa'
// que Stripe reintente). Evento desconocido → 200 {received}.

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

const PLANS = { basico: true, plus: true, premium: true };
// Lo que se ACREDITA por recarga (con bonos) — no lo que se paga.
const TOPUP_CREDIT = { t10: 1000, t20: 2200, t50: 5750 };

// Cuerpo crudo: con bodyParser apagado, req es un stream. Si el
// runtime ya lo trajo como Buffer o texto, se usa tal cual.
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    return Promise.resolve(Buffer.from(req.body, 'utf8'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureOk(raw, header, secret) {
  if (!header || typeof header !== 'string') return false;
  let t = null;
  const v1s = [];
  header.split(',').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    if (k === 'v1') v1s.push(v);
  });
  if (!t || !v1s.length) return false;
  const ts = parseInt(t, 10);
  if (!isFinite(ts)) return false;
  // Tolerancia de 5 minutos contra el reloj de Stripe.
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;
  const signed = Buffer.concat([Buffer.from(t + '.', 'utf8'), raw]);
  const expected = crypto.createHmac('sha256', secret).update(signed).digest();
  return v1s.some((v1) => {
    let got;
    try { got = Buffer.from(v1, 'hex'); } catch (e) { return false; }
    return got.length === expected.length &&
      crypto.timingSafeEqual(got, expected);
  });
}

// Llamada REST con la llave de servicio (igual que api/usage.js).
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

function rpc(name, args) {
  return svc('/rest/v1/rpc/' + name, {
    method: 'POST',
    body: JSON.stringify(args)
  });
}

// Reclama un evento de Stripe en la tabla stripe_events: el
// insert lleva ignore-duplicates, así que si el event_id ya
// estaba, PostgREST devuelve un arreglo VACÍO (nada insertado)
// en vez de un error. Devuelve {claimed:true} solo si el
// renglón se creó en esta entrega.
async function claimEvent(event) {
  const r = await svc('/rest/v1/stripe_events', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=ignore-duplicates,return=representation'
    },
    body: JSON.stringify({ event_id: event.id, type: event.type || null })
  });
  if (!r.ok) return { error: true };
  return { claimed: Array.isArray(r.json) && r.json.length > 0 };
}

// Libera un reclamo (borra el renglón) pa' que el reintento de
// Stripe pueda reclamar el evento otra vez. Si el borrado
// falla, se traga el error: el 500 ya va de salida y un reclamo
// huérfano solo haría que el reintento se descarte como
// duplicado (mal menor frente a un doble crédito).
async function releaseEvent(eventId) {
  try {
    await svc('/rest/v1/stripe_events?event_id=eq.' +
      encodeURIComponent(eventId), { method: 'DELETE' });
  } catch (e) { /* ver el comentario de arriba */ }
}

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const r = await fetch('https://api.stripe.com' + path, {
    headers: { ['Authori' + 'zation']: 'Bearer ' + key }
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

function isoFromUnix(sec) {
  return sec ? new Date(sec * 1000).toISOString() : null;
}

// Busca la fila de derechos dueña de una suscripción de Stripe.
async function entitlementBySub(subId) {
  const q = '/rest/v1/entitlements?stripe_subscription_id=eq.' +
    encodeURIComponent(subId) +
    '&select=user_id,plan,stripe_customer_id&limit=1';
  const r = await svc(q);
  if (!r.ok || !Array.isArray(r.json) || !r.json.length) return null;
  return r.json[0];
}

const handler = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };
  // Id del evento ya reclamado en ESTA entrega (null si aún no
  // se reclama o si la entrega era duplicada). Vive fuera del
  // try pa' que el catch también pueda liberar el reclamo.
  let claimedEventId = null;

  try {
    if (req.method !== 'POST') return fail('method');

    if (!process.env.STRIPE_WEBHOOK_SECRET ||
        !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return fail('webhook_not_configured', 503);
    }

    const raw = await readRawBody(req);
    if (!signatureOk(raw, req.headers['stripe-signature'],
                     process.env.STRIPE_WEBHOOK_SECRET)) {
      return fail('bad_signature', 400);
    }

    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch (e) { return fail('bad_json', 400); }

    // Responder un fallo DESPUÉS de reclamar: primero se libera
    // el reclamo, pa' que el reintento de Stripe no se descarte
    // como duplicado sin haberse aplicado nada.
    const failRetry = async (error, status) => {
      if (claimedEventId) {
        const id = claimedEventId;
        claimedEventId = null;
        await releaseEvent(id);
      }
      return fail(error, status || 500);
    };

    // RECLAMO del evento, antes de cualquier RPC: una sola
    // entrega lo procesa; las demás son duplicadas.
    if (event && event.id) {
      let claim;
      try { claim = await claimEvent(event); }
      catch (e) { return fail('claim_error', 500); }
      if (claim.error) return fail('claim_error', 500);
      if (!claim.claimed) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      claimedEventId = event.id;
    }

    const obj = (event && event.data && event.data.object) || {};

    if (event.type === 'checkout.session.completed') {
      const md = obj.metadata || {};
      const userId = md.user_id, kind = md.kind, item = md.item;

      if (userId && kind === 'topup' && TOPUP_CREDIT[item]) {
        // La idempotencia ya quedó resuelta al inicio del
        // handler con el reclamo en stripe_events: esta entrega
        // es la única que procesa el evento, así que el crédito
        // se aplica directo, sin pre-chequeo en el libro. Si la
        // RPC falla, failRetry libera el reclamo y el reintento
        // de Stripe vuelve a entrar completo.
        const r = await rpc('credit_balance',
          { p_user: userId, p_cents: TOPUP_CREDIT[item] });
        if (!r.ok) return failRetry('db_error', 500);
      } else if (userId && kind === 'plan' && PLANS[item]) {
        if (!obj.subscription) return failRetry('stripe_error', 500);
        const sub = await stripeGet('/v1/subscriptions/' + obj.subscription);
        if (!sub || !sub.current_period_end) return failRetry('stripe_error', 500);
        const r = await rpc('apply_plan', {
          p_user: userId,
          p_plan: item,
          p_cycle_ends: isoFromUnix(sub.current_period_end),
          p_stripe_customer: obj.customer || sub.customer || null,
          p_stripe_sub: obj.subscription
        });
        if (!r.ok) return failRetry('db_error', 500);
      }
      // Una sesión sin metadata nuestra: nada que mover.
    } else if (event.type === 'invoice.paid') {
      // Solo renovaciones de ciclo: el primer pago del plan ya
      // lo aplicó checkout.session.completed.
      if (obj.subscription && obj.billing_reason === 'subscription_cycle') {
        const sub = await stripeGet('/v1/subscriptions/' + obj.subscription);
        if (!sub) return failRetry('stripe_error', 500);
        const ent = await entitlementBySub(obj.subscription);
        if (ent) {
          // El plan sale de la metadata de la suscripción si
          // viene; si no, se conserva el plan guardado.
          const plan = (sub.metadata && PLANS[sub.metadata.item])
            ? sub.metadata.item : ent.plan;
          if (PLANS[plan]) {
            const r = await rpc('apply_plan', {
              p_user: ent.user_id,
              p_plan: plan,
              p_cycle_ends: isoFromUnix(sub.current_period_end),
              p_stripe_customer: sub.customer || ent.stripe_customer_id || null,
              p_stripe_sub: obj.subscription
            });
            if (!r.ok) return failRetry('db_error', 500);
          }
        }
        // Suscripción desconocida aquí: nada que mover.
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const ent = obj.id ? await entitlementBySub(obj.id) : null;
      if (ent) {
        const r = await rpc('apply_plan', {
          p_user: ent.user_id,
          p_plan: 'free',
          // apply_plan exige el fin de ciclo: va el fin real de
          // la suscripción cancelada (o null si Stripe no lo da).
          p_cycle_ends: isoFromUnix(obj.ended_at || obj.current_period_end),
          p_stripe_customer: obj.customer || ent.stripe_customer_id || null,
          p_stripe_sub: obj.id
        });
        if (!r.ok) return failRetry('db_error', 500);
      }
    }
    // Cualquier otro evento: se acusa recibo y nada más.
    res.status(200).json({ received: true });
  } catch (e) {
    // 500 pa' que Stripe reintente: un evento de dinero nunca se
    // pierde en silencio. Si esta entrega ya había reclamado el
    // evento, el reclamo se libera primero (si no, el reintento
    // se descartaría como duplicado sin aplicar nada).
    if (claimedEventId) await releaseEvent(claimedEventId);
    return fail('server_error', 500);
  }
};

module.exports = handler;
// Vercel (el runtime de este repo): sin esto, el cuerpo llega
// parseado como JSON y el cuerpo crudo — imprescindible pa'
// verificar la firma — se pierde.
module.exports.config = { api: { bodyParser: false } };
