// Llamadas telefónicas traducidas (v16): TwiML de cada pata de la llamada.
// Twilio pide esta URL cuando la pata se conecta y ejecuta lo que devuelva.
//
// SIN saludos ni avisos hablados (orden de Noel, 2026-10-23): la llamada
// entra DIRECTA a la traducción — los <Say> quitaban tiempo y tapaban el
// momento en que la otra persona ya estaba lista. (El aviso de traducción
// por IA existía por consentimiento; Noel decidió quitarlo.)
// Cada pata conecta su audio al relay (SOLO la voz entrante,
// track="inbound_track", para que la voz traducida que inyecta el relay
// nunca se re-escuche a sí misma).
//
// El audio va al relay: wss://CALL_RELAY_HOST/stream?leg=..&callId=..
// Sin relay configurado, se dice honestamente que el servicio aún no está
// disponible y se cuelga (nunca se finge la llamada).

const crypto = require('crypto');

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Firma de Twilio (auditoría 2026-10): esta URL la pide Twilio al
// conectar cada pata, con el header X-Twilio-Signature calculado
// sobre la URL EXACTA pedida (con su query string) + los parámetros
// POST ordenados. Sin firma válida NO se sirve TwiML a nadie (el
// navegador nunca llama esta ruta: solo Twilio).
// Verificado antes de codificar: index.html no usa /api/call-twiml
// ni /api/call-status directamente.
function twilioSignatureOk(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const sig = req.headers['x-twilio-signature'];
  if (!authToken || !sig) return false;
  let params = {};
  let b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) params = b;
  else if (typeof b === 'string') {
    params = Object.fromEntries(new URLSearchParams(b));
  } else if (Buffer.isBuffer(b)) {
    params = Object.fromEntries(new URLSearchParams(b.toString('utf8')));
  }
  let base = 'https://englix.app' + (req.url || '');
  const keys = Object.keys(params).sort();
  for (const k of keys) base += k + params[k];
  const expected = crypto.createHmac('sha1', authToken)
    .update(base, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const c = Buffer.from(String(sig));
  return a.length === c.length && crypto.timingSafeEqual(a, c);
}

module.exports = async (req, res) => {
  if (!twilioSignatureOk(req)) {
    res.status(403).send('');
    return;
  }
  const q = req.query || {};
  const leg = q.leg === 'dest' ? 'dest' : 'user';
  // El relay vive en Fly.io desde el 2026-10-22, servido bajo el dominio
  // propio relay.englix.app (registrado en Porkbun el 2026-10-23;
  // certificado Let's Encrypt EXACTO pa' ese nombre + IP dedicada de
  // Fly): Twilio jamás conectó el stream a los subdominios de
  // plataforma (englix-relay.onrender.com, luego englix-relay.fly.dev
  // — 0 conexiones registradas en el relay y 0 errores en Twilio, en
  // 8+ llamadas reales), mientras que al servidor de eco público
  // (ws.postman-echo.com) conectaba y aguantaba minutos. Antes se
  // intentó relay.fluxari.app, pero el DNS de Vercel nunca publicó los
  // registros (7+ horas) y se abandonó esa ruta.
  // La variable CALL_RELAY_HOST de Vercel quedó con el host viejo: aquí
  // manda el dominio propio y la variable solo se respeta si coincide.
  const envRelay = String(process.env.CALL_RELAY_HOST || '')
    .replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const relay = envRelay === 'relay.englix.app' ? envRelay : 'relay.englix.app';

  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  if (!relay) {
    const msg = leg === 'dest'
      ? 'Sorry, the translation service is not available yet. Goodbye.'
      : 'El servicio de llamadas aún no está disponible. Adiós.';
    res.status(200).send(
      '<Response><Say language="' + (leg === 'dest' ? 'en-US' : 'es-US') + '">' +
      msg + '</Say></Response>'
    );
    return;
  }

  // Los datos de la pata van como <Parameter> (llegan al relay en el
  // evento start), NUNCA como parámetros de la URL: la bisección del
  // 2026-10-23 probó que con ?leg=..&callId=.. en la URL Twilio jamás
  // conectó el stream a ningún relay (Render, Fly, dominio propio),
  // mientras que sin parámetros (eco /raw) conectó al instante.
  const streamUrl = 'wss://' + relay + '/stream';
  let params =
    '<Parameter name="leg" value="' + escAttr(leg) + '"/>' +
    '<Parameter name="callId" value="' + escAttr(q.callId || '') + '"/>' +
    '<Parameter name="pairA" value="' + escAttr(q.pairA || 'es') + '"/>' +
    '<Parameter name="pairB" value="' + escAttr(q.pairB || 'en') + '"/>' +
    '<Parameter name="goal" value="' + escAttr(q.goal || '') + '"/>';
  // El token del relay (query rt, puesto por call-start o por
  // call-status) viaja como <Parameter>: la URL del stream sigue
  // SIN parámetros, como manda la bisección.
  if (q.rt) params += '<Parameter name="rt" value="' + escAttr(q.rt) + '"/>';

  res.status(200).send(
    '<Response>' +
    '<Connect><Stream url="' + escAttr(streamUrl) + '" track="inbound_track">' +
    params + '</Stream></Connect>' +
    '</Response>'
  );
};
