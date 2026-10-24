// Llamadas telefónicas (v18): ¿ya quedó verificado el número del usuario?
// GET ?number=(941) 555-0123 → { ok:true, verified:true|false }
// Fuente de verdad: la lista de Outgoing Caller IDs de Twilio. Cuando el
// usuario marca el código en la llamada de validación, su número aparece
// en esa lista.

function normalizeUS(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length !== 11 || d.charAt(0) !== '1') return null;
  return '+' + d;
}

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Consultar si un número está verificado exige sesión válida de
   Supabase (el mismo patrón de validación de api/usage.js). */
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

module.exports = async (req, res) => {
  try {
    // Puerta: solo usuarios con sesión válida consultan esto.
    const auth = String(req.headers.authorization || req.headers.Authorization || '');
    const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    const user = token ? await userFromToken(token).catch(() => null) : null;
    if (!user) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !twilioToken) {
      return res.status(200).json({ ok: false, error: 'calls_not_configured' });
    }

    const mine = normalizeUS((req.query || {}).number);
    if (!mine) return res.status(200).json({ ok: false, error: 'bad_number' });

    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + sid +
        '/OutgoingCallerIds.json?PhoneNumber=' + encodeURIComponent(mine),
      {
        headers: {
          ['Authori' + 'zation']:
            'Basic ' + Buffer.from(sid + ':' + twilioToken).toString('base64')
        }
      }
    );
    const j = await r.json().catch(() => ({}));
    const verified = !!(r.ok && j && Array.isArray(j.outgoing_caller_ids) &&
      j.outgoing_caller_ids.length);
    res.status(200).json({ ok: true, verified });
  } catch (e) {
    res.status(200).json({ ok: false, error: 'server_error' });
  }
};
