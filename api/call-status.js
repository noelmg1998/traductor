// Llamadas telefónicas traducidas (v16): aviso de estado de la pata "user".
// Twilio llama aquí cuando la llamada del usuario cambia de estado. Cuando
// el usuario CONTESTA (CallStatus = in-progress, evento que llega una sola
// vez por llamada), se crea la pata "dest": recién ahí suena el teléfono de
// la otra persona. Así el destino nunca suena en vano.
//
// Sin estado en el servidor: todo lo necesario (destino, callId, par de
// idiomas, motivo) viaja en los parámetros de esta misma URL.

module.exports = async (req, res) => {
  try {
    const q = req.query || {};

    // El cuerpo de Twilio llega como form-urlencoded; según el runtime puede
    // venir ya parseado (objeto), como texto o como Buffer. Se aceptan los 3.
    let b = req.body || {};
    if (typeof b === 'string') b = Object.fromEntries(new URLSearchParams(b));
    else if (Buffer.isBuffer(b)) {
      b = Object.fromEntries(new URLSearchParams(b.toString('utf8')));
    }

    if (q.leg === 'user' && b.CallStatus === 'in-progress' && q.dest) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_PHONE_NUMBER;
      if (sid && token && from) {
        const base = 'https://' + (req.headers.host || 'traductor-prueba-muse-ce8f.vercel.app');
        const twimlQ = new URLSearchParams({
          leg: 'dest',
          callId: q.callId || '',
          goal: q.goal || '',
          pairA: q.pairA || 'es',
          pairB: q.pairB || 'en'
        });
        const form = new URLSearchParams();
        form.set('To', q.dest);
        form.set('From', from);
        form.set('Url', base + '/api/call-twiml?' + twimlQ.toString());
        form.set('Method', 'POST');
        await fetch(
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
        ).catch(() => null);
      }
    }
  } catch (e) {
    // Un aviso de estado nunca debe tumbar nada: se responde 200 igual.
  }
  res.status(200).send('');
};
