// Llamadas telefónicas traducidas (v16): TwiML de cada pata de la llamada.
// Twilio pide esta URL cuando la pata se conecta y ejecuta lo que devuelva.
//
// pata "user" (el cliente de Englix): saludo corto en español y conecta el
//   audio (SOLO la voz entrante, track="inbound_track", para que la voz
//   traducida que inyecta el relay nunca se re-escuche a sí misma).
// pata "dest" (la otra persona): primero el aviso EN INGLÉS de que la
//   llamada será traducida por IA (consentimiento — Florida es two-party),
//   y después conecta su audio igual.
//
// El audio va al relay: wss://CALL_RELAY_HOST/stream?leg=..&callId=..
// Sin relay configurado, se dice honestamente que el servicio aún no está
// disponible y se cuelga (nunca se finge la llamada).

function escAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = async (req, res) => {
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

  const say = leg === 'dest'
    ? '<Say language="en-US" voice="Polly.Joanna">Hello. This call is being ' +
      'translated by Englix using artificial intelligence, so the caller can ' +
      'talk with you in English. Please stay on the line.</Say>'
    : '<Say language="es-US" voice="Polly.Lupe">Conectando tu llamada. Habla ' +
      'en español con calma; la otra persona te escuchará en inglés.</Say>';

  const streamUrl = 'wss://' + relay + '/stream' +
    '?leg=' + leg +
    '&callId=' + encodeURIComponent(q.callId || '') +
    '&pairA=' + encodeURIComponent(q.pairA || 'es') +
    '&pairB=' + encodeURIComponent(q.pairB || 'en') +
    '&goal=' + encodeURIComponent(q.goal || '');

  res.status(200).send(
    '<Response>' + say +
    '<Connect><Stream url="' + escAttr(streamUrl) + '" track="inbound_track" /></Connect>' +
    '</Response>'
  );
};
