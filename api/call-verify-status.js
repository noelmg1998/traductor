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

module.exports = async (req, res) => {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
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
            'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
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
