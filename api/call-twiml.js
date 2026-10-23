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
  const relay = String(process.env.CALL_RELAY_HOST || '')
    .replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

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

  // SONDA TEMPORAL (2026-10-22): las llamadas reales de Twilio jamás
  // conectaron el stream al relay en Render (0 conexiones registradas en
  // todos los intentos), aunque clientes externos sí conectan y traducen.
  // Esta sonda manda el stream a un servidor de eco público pa' separar el
  // problema: si la llamada se MANTIENE, Twilio sí sostiene streams con
  // terceros y lo roto es la ruta Twilio→Render. REVERTIR tras la prueba.
  const PROBE_ECHO = true;
  const streamUrl = (PROBE_ECHO
    ? 'wss://ws.postman-echo.com/raw'
    : 'wss://' + relay + '/stream') +
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
