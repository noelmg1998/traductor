// Llamadas telefónicas traducidas (v16): aviso de estado de las patas.
// Twilio llama aquí cuando una pata cambia de estado:
//  - Cuando el USUARIO contesta (CallStatus = in-progress), se crea la pata
//    "dest": recién ahí suena el teléfono de la otra persona. Así el destino
//    nunca suena en vano.
//  - Cuando CUALQUIERA de las dos patas termina (CallStatus = completed),
//    se cuelga la pata hermana: si una persona cuelga, la otra no se puede
//    quedar en una llamada abierta sola (reportado por Noel el 2026-10-22:
//    él colgaba y la otra persona seguía en la llamada).
//
// Sin estado en el servidor: todo lo necesario (destino, callId, par de
// idiomas, motivo, números de la pata hermana) viaja en los parámetros de
// esta misma URL o en el cuerpo que Twilio manda.

function twilioAuth(sid, token) {
  return {
    ['Authori' + 'zation']:
      'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
  };
}

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

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const api = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Calls';

    // Cuelga la(s) pata(s) hermana(s) que sigan vivas: se buscan por su
    // To + From exactos (los de ESTA llamada) en estados previos a terminar.
    const hangupSiblings = async (to, fromNum) => {
      if (!sid || !token || !to || !fromNum) return;
      const statuses = ['queued', 'ringing', 'in-progress'];
      for (const st of statuses) {
        try {
          const u = api + '.json?To=' + encodeURIComponent(to) +
            '&From=' + encodeURIComponent(fromNum) + '&Status=' + st + '&PageSize=5';
          const r = await fetch(u, { headers: twilioAuth(sid, token) });
          const j = await r.json().catch(() => ({}));
          const list = (j && j.calls) || [];
          for (const c of list) {
            if (!c || !c.sid) continue;
            const form = new URLSearchParams();
            form.set('Status', 'completed');
            await fetch(api + '/' + c.sid + '.json', {
              method: 'POST',
              headers: Object.assign(twilioAuth(sid, token), {
                'Content-Type': 'application/x-www-form-urlencoded'
              }),
              body: form.toString()
            }).catch(() => null);
          }
        } catch (e) { /* seguir con el próximo estado */ }
      }
    };

    // — La pata del usuario terminó: colgar la del destino.
    if (q.leg === 'user' && b.CallStatus === 'completed' && q.dest) {
      const from = (typeof q.from === 'string' && /^\+1\d{10}$/.test(q.from))
        ? q.from : process.env.TWILIO_PHONE_NUMBER;
      await hangupSiblings(q.dest, from);
    }

    // — La pata del destino terminó: colgar la del usuario.
    if (q.leg === 'dest' && b.CallStatus === 'completed' &&
        /^\+1\d{10}$/.test(q.userTo || '') &&
        /^\+1\d{10}$/.test(q.userFrom || '')) {
      await hangupSiblings(q.userTo, q.userFrom);
    }

    // — El usuario contestó: crear la pata destino.
    if (q.leg === 'user' && q.dest &&
        (b.CallStatus === 'in-progress' || b.CallStatus === 'answered')) {
      // v18: el origen de la pata destino lo decide call-start (el número
      // verificado del usuario si lo tiene; si no, el de Englix).
      const from = (typeof q.from === 'string' && /^\+1\d{10}$/.test(q.from))
        ? q.from : process.env.TWILIO_PHONE_NUMBER;
      if (sid && token && from) {
        const base = 'https://' + (req.headers.host || 'traductor-prueba-muse-ce8f.vercel.app');
        const twimlQ = new URLSearchParams({
          leg: 'dest',
          callId: q.callId || '',
          goal: q.goal || '',
          pairA: q.pairA || 'es',
          pairB: q.pairB || 'en'
        });
        // La pata destino avisa a ESTA misma función al terminar, pa'
        // poder colgar la del usuario si la otra persona cuelga primero.
        // En el cuerpo de este aviso, To/From son los de la pata usuario.
        const statusQ = new URLSearchParams({
          leg: 'dest',
          callId: q.callId || '',
          userTo: /^\+1\d{10}$/.test(b.To || '') ? b.To : '',
          userFrom: /^\+1\d{10}$/.test(b.From || '') ? b.From : ''
        });
        const form = new URLSearchParams();
        form.set('To', q.dest);
        form.set('From', from);
        form.set('Url', base + '/api/call-twiml?' + twimlQ.toString());
        form.set('Method', 'POST');
        form.set('StatusCallback', base + '/api/call-status?' + statusQ.toString());
        form.set('StatusCallbackMethod', 'POST');
        form.append('StatusCallbackEvent', 'completed');
        await fetch(api + '.json', {
          method: 'POST',
          headers: Object.assign(twilioAuth(sid, token), {
            'Content-Type': 'application/x-www-form-urlencoded'
          }),
          body: form.toString()
        }).catch(() => null);
      }
    }
  } catch (e) {
    // Un aviso de estado nunca debe tumbar nada: se responde 200 igual.
  }
  res.status(200).send('');
};
