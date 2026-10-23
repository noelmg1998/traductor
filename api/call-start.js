// Llamadas telefónicas traducidas (v16): inicia la llamada.
// Recibe { toNumber, myNumber, goal, pairA, pairB } del navegador.
// Marca PRIMERO al usuario (pata "user"); cuando contesta, Twilio avisa a
// /api/call-status y ESE paso crea la llamada a la otra persona (pata
// "dest"), para que el destino nunca suene si el usuario no contestó.
//
// Credenciales SOLO en variables de entorno de Vercel:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (origen)
//   CALL_RELAY_HOST: host del servidor de audio (ej. englix-relay.fly.dev);
//   sin él, la función responde relay_not_configured y la app lo dice
//   honestamente ("falta encender el servidor de llamadas").

const crypto = require('crypto');

const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

// Normaliza un número de EE.UU. a E.164 (+1XXXXXXXXXX). Acepta con o sin +1.
function normalizeUS(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length !== 11 || d.charAt(0) !== '1') return null;
  return '+' + d;
}

module.exports = async (req, res) => {
  const fail = (error, extra) => {
    res.status(200).json(Object.assign({ ok: false, error }, extra || {}));
  };

  try {
    if (req.method !== 'POST') return fail('method');

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;
    // Relay en Fly.io (ver la nota en call-twiml.js): la variable
    // CALL_RELAY_HOST quedó con el host viejo de Render; manda fly.dev.
    const envRelay = String(process.env.CALL_RELAY_HOST || '')
      .replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const relay = envRelay.indexOf('fly.dev') >= 0 ? envRelay : 'englix-relay.fly.dev';
    if (!sid || !token || !from) return fail('calls_not_configured');
    if (!relay) return fail('relay_not_configured');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const to = normalizeUS(body.toNumber);
    const mine = normalizeUS(body.myNumber);
    if (!to || !mine || to === mine) return fail('bad_number');

    let pairA = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'es';
    let pairB = ALLOWED_LANGUAGES.indexOf(body.pairB) >= 0 ? body.pairB : 'en';
    if (pairA === pairB) pairB = pairA === 'es' ? 'en' : 'es';
    const goal = String(body.goal || '').slice(0, 140);

    // v18: si el usuario verificó SU número en Twilio (Outgoing Caller ID),
    // la pata del destino sale mostrando SU número real y la otra persona
    // reconoce quién llama. Si no, sale el número de Englix.
    let destFrom = from;
    try {
      const vr = await fetch(
        'https://api.twilio.com/2010-04-01/Accounts/' + sid +
          '/OutgoingCallerIds.json?PhoneNumber=' + encodeURIComponent(mine),
        {
          headers: {
            ['Authori' + 'zation']:
              'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
          }
        }
      );
      const vj = await vr.json().catch(() => ({}));
      if (vr.ok && vj && Array.isArray(vj.outgoing_caller_ids) &&
          vj.outgoing_caller_ids.length) {
        destFrom = mine;
      }
    } catch (e) { /* si la consulta falla, se usa el número de Englix */ }

    const callId = crypto.randomUUID();
    const base = 'https://' + (req.headers.host || 'traductor-prueba-muse-ce8f.vercel.app');

    const twimlQ = new URLSearchParams({
      leg: 'user', callId, dest: to, goal, pairA, pairB
    });
    const statusQ = new URLSearchParams({
      leg: 'user', callId, dest: to, from: destFrom, goal, pairA, pairB
    });

    const form = new URLSearchParams();
    form.set('To', mine);
    form.set('From', from);
    form.set('Url', base + '/api/call-twiml?' + twimlQ.toString());
    form.set('Method', 'POST');
    form.set('StatusCallback', base + '/api/call-status?' + statusQ.toString());
    form.set('StatusCallbackMethod', 'POST');
    // OJO: los eventos válidos de Twilio son initiated/ringing/answered/
    // completed. "in-progress" es un ESTADO, no un evento: Twilio lo
    // rechazaba con el warning 21626 y NUNCA avisaba — por eso la pata
    // destino no se creaba y la llamada se caía tras el saludo
    // (confirmado en el registro de llamadas del 2026-10-22). El aviso
    // 'answered' llega con CallStatus = in-progress en el cuerpo.
    form.append('StatusCallbackEvent', 'answered');
    form.append('StatusCallbackEvent', 'completed');

    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Calls.json',
      {
        method: 'POST',
        headers: {
          ['Authori' + 'zation']:
            'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
      }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = j && j.message
        ? String(j.code || '') + ': ' + String(j.message).slice(0, 200)
        : 'status ' + r.status;
      return fail('twilio_error', { detail });
    }

    res.status(200).json({
      ok: true, callId, relayHost: relay,
      callerId: destFrom === mine ? 'own' : 'englix'
    });
  } catch (e) {
    return fail('server_error');
  }
};
