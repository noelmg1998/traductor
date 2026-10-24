// Eliminar cuenta (v44): borra el usuario de Supabase Auth.
//
// La app manda POST (sin cuerpo necesario) con el access token de
// la sesión en el header Authorization: Bearer <token>. El usuario
// NUNCA viene del cuerpo: se deriva del token, validándolo contra
// Supabase Auth (GET /auth/v1/user, el mismo mecanismo que usa
// api/usage.js). Solo se puede borrar la PROPIA cuenta.
//
// El borrado se hace con la Admin API de Supabase
// (DELETE /auth/v1/admin/users/{id}) y la llave de servicio; al
// borrar el usuario, sus filas en profiles/entitlements caen por
// la FK on delete cascade.
//
// Variables de entorno (Vercel): SUPABASE_URL / SUPABASE_ANON_KEY
// caen a los valores PÚBLICOS del proyecto (los mismos de
// index.html). Sin SUPABASE_SERVICE_ROLE_KEY la función responde
// 503 { error: 'not_configured' } y la app muestra el aviso
// honesto: nunca se finge una eliminación.

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

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method');

    // Sin llave de servicio NO se puede borrar: se dice la verdad
    // (503) y la app muestra el aviso honesto.
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!svcKey) {
      return fail('not_configured', 503);
    }

    // El usuario sale SOLO del token.
    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!token) return fail('unauthorized', 401);
    const user = await userFromToken(token).catch(() => null);
    if (!user) return fail('unauthorized', 401);

    // ANTES de borrar: cancelar la suscripción de Stripe si la
    // hay (auditoría H-2). Sin esto, el usuario borrado seguía
    // pagando cada mes y las renovaciones reventaban contra un
    // usuario inexistente. Se lee su fila de entitlements con la
    // llave de servicio; si trae stripe_subscription_id se
    // cancela de inmediato en Stripe (DELETE
    // /v1/subscriptions/{id}). Un 404 de Stripe (ya no existe)
    // está bien. Cualquier otro fallo — o la falta de
    // STRIPE_SECRET_KEY — NO bloquea el borrado: el derecho del
    // usuario a eliminar su cuenta manda, y la suscripción
    // queda registrada en el log pa' seguimiento manual.
    try {
      const er = await fetch(
        SUPABASE_URL + '/rest/v1/entitlements?user_id=eq.' +
          encodeURIComponent(user.id) +
          '&select=stripe_customer_id,stripe_subscription_id&limit=1',
        {
          headers: {
            apikey: svcKey,
            ['Authori' + 'zation']: 'Bearer ' + svcKey
          }
        });
      const rows = er.ok ? await er.json().catch(() => null) : null;
      const ent = Array.isArray(rows) && rows.length ? rows[0] : null;
      const subId = ent && ent.stripe_subscription_id;
      if (subId) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error('delete-account: STRIPE_SECRET_KEY missing; subscription not cancelled:', subId);
        } else {
          const sr = await fetch(
            'https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(subId),
            {
              method: 'DELETE',
              headers: { ['Authori' + 'zation']: 'Bearer ' + stripeKey }
            }).catch(() => null);
          if (!sr) {
            console.error('delete-account: Stripe cancel request failed; subscription may still be active:', subId);
          } else if (!sr.ok && sr.status !== 404) {
            console.error('delete-account: Stripe cancel failed with status', sr.status, 'for subscription:', subId);
          }
        }
      }
    } catch (e) {
      // La lectura/cancelación nunca bloquea el borrado.
      console.error('delete-account: subscription pre-check failed:', e && e.message);
    }

    const r = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(user.id), {
      method: 'DELETE',
      headers: {
        apikey: svcKey,
        ['Authori' + 'zation']: 'Bearer ' + svcKey
      }
    });
    if (!r.ok) return fail('delete_failed', 502);

    res.status(200).json({ ok: true });
  } catch (e) {
    return fail('server_error');
  }
};
