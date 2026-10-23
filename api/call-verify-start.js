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

module.exports = async (req, res) => {
  const fail = (error, extra) => {
    res.status(200).json(Object.assign({ ok: false, error }, extra || {}));
  };

  try {
    if (req.method !== 'POST') return fail('method');

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return fail('calls_not_configured');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

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
      const detail = j && j.message
        ? String(j.code || '') + ': ' + String(j.message).slice(0, 200)
        : 'status ' + r.status;
      return fail('twilio_error', { detail });
    }

    res.status(200).json({ ok: true, code: String(j.validation_code) });
  } catch (e) {
    return fail('server_error');
  }
};
