// Englix — relay de llamadas telefónicas traducidas.
//
// Servidor persistente (WebSocket) que puentea las DOS patas de una llamada
// de Twilio con sesiones intérprete de OpenAI Realtime:
//   pata "user" (el cliente, habla el idioma A) ──┐
//   pata "dest" (la otra persona, idioma B) ─────┤
// Cada pata tiene SU sesión intérprete (mismo motor y mismas reglas que la
// app: gpt-realtime-2.1-mini, esperar la frase completa, solo traducir).
// Lo que una sesión produce en voz se inyecta en la pata CONTRARIA.
// Twilio manda solo la voz entrante de cada pata (track="inbound_track"),
// así la voz traducida nunca se re-escucha a sí misma.
//
// Sin credenciales de Twilio: el relay solo recibe audios. La llave de
// OpenAI vive en la variable de entorno OPENAI_API_KEY de ESTE servidor.
//
// Al terminar la llamada genera el resumen en español (modelo fuerte) y lo
// sirve en GET /summary/:callId para que la app lo muestre y lo guarde.

const http = require('http');
const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

// v2 (diagnóstico 2026-10-22): que NADA tumbe el proceso en silencio —
// todo error global queda en el registro de Render con su causa.
process.on('uncaughtException', (e) =>
  console.error('[relay] UNCAUGHT', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) =>
  console.error('[relay] UNHANDLED', e && e.stack ? e.stack : String(e)));

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
// Secreto compartido con api/call-start.js (auditoría 2026-10):
// call-start acuña un token por llamada y este relay lo exige
// antes de abrir sesiones de OpenAI y pa' entregar el resumen.
// Formato: v1.<callId>.<expUnix>.<base64url(HMAC-SHA256)>
const RELAY_SECRET = process.env['RELAY_SHARED_SECRET'] || '';

function verifyRelayToken(rt, callId) {
  if (!rt || !RELAY_SECRET || !callId) return false;
  const parts = String(rt).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  if (parts[1] !== callId) return false;
  const exp = parseInt(parts[2], 10);
  if (!exp || exp * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', RELAY_SECRET)
    .update(parts[1] + '.' + parts[2]).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[3]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const MODEL = 'gpt-realtime-2.1-mini';
const VOICE = 'marin';
const SUMMARY_MODEL = 'gpt-5.5';

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', hi: 'Hindi', ru: 'Russian', id: 'Indonesian'
};
const LANG_OK = Object.keys(LANG_NAMES);

// Mismas instrucciones del intérprete que usa la app (api/rt-token.js).
function interpreterInstructions(aName, bName) {
  return 'You are a simultaneous interpreter between ' + aName + ' and ' + bName + '. ' +
    'Your ONLY job is translation. Rules: ' +
    '(1) Whatever you hear in ' + aName + ', say it in ' + bName + '. ' +
    '(2) Whatever you hear in ' + bName + ', say it in ' + aName + '. ' +
    '(3) Output ONLY the translation — never answer questions, never add ' +
    'explanations, comments, greetings or phrases like \'he said\' or \'in English:\'. ' +
    '(4) Match the speaker\'s tone and register, including jobsite/colloquial speech. ' +
    '(5) If you hear your own translated voice played back, stay silent. ' +
    '(6) If speech is unclear, stay silent rather than inventing.';
}

// callId -> { pairA, pairB, goal, legs:{user:legObj,dest:legObj}, pairs:[],
//             stopped:0, finalized:false, summary:null, ready:false,
//             createdAt, dest }
const calls = new Map();

function getCall(id) {
  let c = calls.get(id);
  if (!c) {
    c = {
      id, pairA: 'es', pairB: 'en', goal: '', dest: '',
      legs: {}, pairs: [], stopped: 0, finalized: false,
      summary: null, ready: false, createdAt: Date.now()
    };
    calls.set(id, c);
    // Duración máxima de una llamada: 3 horas. Al vencer, se
    // finaliza (resumen) y se cierra todo lo que siga abierto.
    c.maxTimer = setTimeout(() => {
      console.log('[relay] duración máxima alcanzada', id);
      try { finalize(c); } catch (e) {}
    }, 3 * 60 * 60 * 1000);
    if (c.maxTimer.unref) c.maxTimer.unref();
  }
  return c;
}

/* ---------------- OpenAI Realtime por pata ---------------- */

function openSession(call, leg) {
  // Si la pata ya tenía una sesión (start repetido), la anterior se
  // cierra y se suelta ANTES de asignar la nueva: nada de sesiones
  // de OpenAI apiladas en la misma pata.
  if (leg.oa) {
    try { leg.oa.close(); } catch (e) {}
    leg.oa = null;
  }
  const hearLang = leg.name === 'user' ? call.pairA : call.pairB;
  const speakLang = leg.name === 'user' ? call.pairB : call.pairA;
  leg.hearLang = hearLang;
  leg.speakLang = speakLang;

  const oa = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=' + MODEL,
    { headers: { ['Authori' + 'zation']: 'Bearer ' + OPENAI_KEY } }
  );
  leg.oa = oa;
  leg.pendingOrig = null;
  leg.receivingUntil = 0; // hasta cuándo ESTA pata está escuchando una traducción
  leg.playBytes = 0;      // bytes de la traducción que está sonando en la contraria
  leg.playFirstAt = 0;    // cuándo empezó a generarse esa traducción

  oa.on('open', () => {
    console.log('[relay] openai ws abierto', call.id, leg.name);
    // La configuración se manda al recibir session.created (orden oficial).
  });

  oa.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!ev || !ev.type) return;

    if (ev.type === 'session.created') {
      try { oa.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: interpreterInstructions(
            LANG_NAMES[call.pairA], LANG_NAMES[call.pairB]
          ),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: 'far_field' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,
                prefix_padding_ms: 300,
                silence_duration_ms: 1100,
                create_response: true,
                interrupt_response: false
              }
            },
            output: { format: { type: 'audio/pcmu' }, voice: VOICE }
          }
        }
      }));
      leg.ready = true;
      console.log('[relay] sesión lista', call.id, leg.name, leg.hearLang, '->', leg.speakLang);
      } catch (e) {
        console.error('[relay] session.update falló', call.id, leg.name, e.message);
      }
      return;
    }

    // Turnos estrictos (regla de Noel): mientras la traducción SUENA en la
    // pata contraria, el micrófono de esa pata NO se procesa — así nadie
    // corta la traducción hablando encima ni entra el eco por altavoz.
    // OpenAI genera más rápido que el tiempo real, así que el turno se
    // mide por la DURACIÓN del audio (bytes ÷ 8000 = segundos de μ-law).
    if (ev.type === 'response.created') {
      leg.playBytes = 0;
      leg.playFirstAt = 0;
      return;
    }
    if (ev.type === 'response.done') {
      const other = call.legs[leg.name === 'user' ? 'dest' : 'user'];
      if (other && leg.playFirstAt) {
        const audioMs = (leg.playBytes / 8000) * 1000;
        const generatedMs = Date.now() - leg.playFirstAt;
        const remainingMs = Math.max(0, audioMs - generatedMs);
        other.receivingUntil = Date.now() + remainingMs + 350; // cola de seguridad
      }
      leg.playBytes = 0;
      leg.playFirstAt = 0;
      return;
    }

    if (ev.type === 'response.output_audio.delta' && ev.delta) {
      if (!leg.playFirstAt) leg.playFirstAt = Date.now();
      leg.playBytes += Math.floor((ev.delta.length * 3) / 4);
      // La voz traducida de ESTA pata suena en la pata contraria.
      const other = call.legs[leg.name === 'user' ? 'dest' : 'user'];
      if (other && other.ws && other.ws.readyState === WebSocket.OPEN && other.streamSid) {
        try {
          other.ws.send(JSON.stringify({
            event: 'media',
            streamSid: other.streamSid,
            media: { payload: ev.delta }
          }));
        } catch (e) {
          console.error('[relay] envío a la otra pata falló', call.id, leg.name, e.message);
        }
      }
      return;
    }

    if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      const text = String(ev.transcript || '').trim();
      if (text) {
        if (leg.pendingOrig) flushPair(call, leg, '');
        leg.pendingOrig = text;
      }
      return;
    }

    if (ev.type === 'response.output_audio_transcript.done') {
      const text = String(ev.transcript || '').trim();
      if (text) flushPair(call, leg, text);
      return;
    }

    if (ev.type === 'error') {
      console.error('[relay] openai error', call.id, leg.name,
        JSON.stringify(ev).slice(0, 400));
    }
  });

  oa.on('error', (e) => console.error('[relay] openai ws error', call.id, leg.name, e.message));
  oa.on('close', (code, reason) => {
    leg.ready = false;
    const other = call.legs[leg.name === 'user' ? 'dest' : 'user'];
    if (other) other.receivingUntil = 0; // nunca dejar el turno trabado
    console.log('[relay] openai ws cerrado', call.id, leg.name, 'code', code,
      reason ? String(reason).slice(0, 120) : '');
  });
}

function flushPair(call, leg, transText) {
  // Tope de memoria: ninguna llamada guarda más de 2000 pares.
  if (call.pairs.length < 2000) {
    call.pairs.push({
      orig: leg.pendingOrig || '',
      origLang: leg.hearLang,
      trans: transText || '',
      transLang: leg.speakLang
    });
  }
  leg.pendingOrig = null;
}

/* ---------------- Resumen en español ---------------- */

async function makeSummary(call) {
  if (call.ready) return;
  call.ready = true; // el resumen puede quedar vacío si no hubo conversación
  if (!call.pairs.length || !OPENAI_KEY) { call.summary = ''; return; }

  const lines = call.pairs.map((p) =>
    '- (' + p.origLang + ') ' + (p.orig || '…') +
    (p.trans ? '  →  (' + p.transLang + ') ' + p.trans : '')
  ).join('\n');

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        ['Authori' + 'zation']: 'Bearer ' + OPENAI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          {
            role: 'system',
            content: 'Eres Englix. Resume en español claro y breve una llamada ' +
              'telefónica traducida. Incluye solo lo que la conversación ' +
              'muestra: el motivo, qué se acordó, fechas, horas, montos, ' +
              'nombres y direcciones mencionados, y los próximos pasos. Sin ' +
              'inventar nada. Máximo unas 6 líneas.'
          },
          {
            role: 'user',
            content: (call.goal ? 'Motivo indicado por quien llamó: ' + call.goal + '\n\n' : '') +
              'Conversación (original → traducción):\n' + lines
          }
        ]
      })
    });
    const j = await r.json().catch(() => ({}));
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      ? String(j.choices[0].message.content || '').trim() : '';
    call.summary = text;
  } catch (e) {
    console.error('[relay] summary failed', call.id, e.message);
    call.summary = '';
  }
}

function finalize(call) {
  if (call.finalized) return;
  call.finalized = true;
  // Cierra lo que siga abierto.
  for (const name of ['user', 'dest']) {
    const leg = call.legs[name];
    if (leg) {
      if (leg.pendingOrig) flushPair(call, leg, '');
      try { if (leg.oa) leg.oa.close(); } catch (e) {}
      try { if (leg.ws) leg.ws.close(); } catch (e) {}
    }
  }
  makeSummary(call).catch(() => { call.ready = true; call.summary = ''; });
}

/* ---------------- HTTP (salud y resumen) ---------------- */

const server = http.createServer((req, res) => {
  // CORS cerrado a la app (auditoría 2026-10): solo englix.app.
  res.setHeader('Access-Control-Allow-Origin', 'https://englix.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-relay-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const m = url.pathname.match(/^\/summary\/([A-Za-z0-9-]+)$/);
  if (m) {
    // El resumen trae la conversación COMPLETA: solo se entrega
    // con el token del relay de ESA llamada (header x-relay-token).
    if (!verifyRelayToken(req.headers['x-relay-token'], m[1])) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const call = calls.get(m[1]);
    if (!call) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: 'unknown' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      status: call.ready ? 'ready' : 'pending',
      summary: call.summary || '',
      pairs: call.pairs,
      endedAt: call.finalized ? Date.now() : null
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

/* ---------------- WebSocket de Twilio ---------------- */

// Límites (auditoría 2026-10): payload máximo por mensaje (las
// tramas de Twilio son de pocos KB), tope de conexiones por IP y
// global, y latido ping/pong pa' tumbar sockets muertos.
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
const ipCounts = new Map();
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  let call = null;
  let leg = null;
  let callId = '';
  let legName = 'user';

  // Latido + tope por IP (20 conexiones concurrentes por IP).
  const ip = (req.socket && req.socket.remoteAddress) || '?';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if ((ipCounts.get(ip) || 0) >= 20) {
    try { ws.close(4429); } catch (e) {}
    return;
  }
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  ws.on('close', () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
  });

  // Los datos de la pata llegan por <Parameter> del TwiML (evento
  // start, start.customParameters) o, de respaldo, por la URL. La
  // bisección del 2026-10-23 probó que Twilio NUNCA conectó cuando la
  // URL del stream llevaba parámetros (?leg=..&callId=..): contra el
  // eco /raw sin parámetros conectó al instante en las dos patas.
  function setup(p) {
    legName = p.leg === 'dest' ? 'dest' : 'user';
    callId = p.callId || '';
    if (!callId) { try { ws.close(); } catch (e) {} return false; }
    // Token del relay (auditoría 2026-10): acuñado por call-start
    // pa' ESTA llamada. Sin token válido y vigente NO se crea
    // registro ni sesión de OpenAI alguna.
    if (!verifyRelayToken(p.rt, callId)) {
      console.error('[relay] token inválido o ausente; conexión rechazada', callId, legName);
      try { ws.close(4401); } catch (e) {}
      return false;
    }
    // Tope de llamadas vivas en memoria.
    if (!calls.has(callId) && calls.size >= 500) {
      try { ws.close(4429); } catch (e) {}
      return false;
    }
    call = getCall(callId);
    // Reclamo de pata: una sola conexión viva por pata y llamada;
    // una segunda que intente ocupar la misma pata se rechaza.
    const existing = call.legs[legName];
    if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN) {
      console.error('[relay] pata ya ocupada; conexión rechazada', callId, legName);
      try { ws.close(4409); } catch (e) {}
      return false;
    }
    if (LANG_OK.indexOf(p.pairA) >= 0) call.pairA = p.pairA;
    if (LANG_OK.indexOf(p.pairB) >= 0 && p.pairB !== call.pairA) call.pairB = p.pairB;
    if (p.goal) call.goal = String(p.goal).slice(0, 140);
    if (p.dest) call.dest = p.dest;
    leg = { name: legName, ws, streamSid: null, oa: null, ready: false };
    call.legs[legName] = leg;
    console.log('[relay] stream conectado', callId, legName,
      call.pairA, call.pairB, 'desde', (req.socket && req.socket.remoteAddress) || '?');
    return true;
  }

  if (url.searchParams.get('callId')) {
    setup({
      leg: url.searchParams.get('leg'),
      callId: url.searchParams.get('callId'),
      pairA: url.searchParams.get('pairA'),
      pairB: url.searchParams.get('pairB'),
      goal: url.searchParams.get('goal'),
      dest: url.searchParams.get('dest'),
      rt: url.searchParams.get('rt')
    });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.event) return;

    if (msg.event === 'start') {
      if (!leg) {
        const cp = (msg.start && msg.start.customParameters) || {};
        if (!setup(cp)) return;
      }
      leg.streamSid = msg.start && msg.start.streamSid;
      console.log('[relay] start', callId, legName, 'streamSid', leg.streamSid || '?');
      // Un segundo start en el MISMO socket no apila otra sesión:
      // la de esta pata ya existe.
      if (leg.oa) return;
      if (OPENAI_KEY) openSession(call, leg);
      else console.error('[relay] falta OPENAI_API_KEY en el servidor');
      return;
    }
    if (!leg) return;
    if (msg.event === 'media') {
      if (Date.now() < (leg.receivingUntil || 0)) return; // está escuchando una traducción: su micrófono espera
      if (leg.oa && leg.oa.readyState === WebSocket.OPEN && leg.ready) {
        try {
          leg.oa.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media && msg.media.payload
          }));
        } catch (e) {
          console.error('[relay] append a openai falló', callId, legName, e.message);
        }
      }
      return;
    }
    if (msg.event === 'stop') {
      console.log('[relay] stop de twilio', callId, legName);
      call.stopped += 1;
      try { if (leg.oa) leg.oa.close(); } catch (e) {}
      if (call.stopped >= 2) finalize(call);
      else setTimeout(() => finalize(call), 12000); // la otra pata puede tardar
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[relay] stream cerrado', callId, legName, 'code', code,
      reason ? String(reason).slice(0, 120) : '');
    try { if (leg && leg.oa) leg.oa.close(); } catch (e) {}
    // Si el stream se cae SIN evento stop, la llamada no queda
    // "pending" pa' siempre: se finaliza con la misma gracia de
    // 12 s que usa el stop de una sola pata (finalize es idempotente).
    if (call && !call.finalized) {
      const c = call;
      setTimeout(() => { try { finalize(c); } catch (e) {} }, 12000);
    }
  });
  ws.on('error', (e) => console.error('[relay] stream error', callId, legName, e.message));
});

/* El endpoint de eco /raw (diagnóstico del 2026-10-23) se ELIMINÓ
   en la auditoría 2026-10: era superficie de ataque sin uso. */

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) {}
  if (pathname === '/stream') {
    // Tope global de conexiones simultáneas.
    if (wss.clients.size >= 200) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Cierra los sockets (Twilio y OpenAI) de una llamada antes de
// borrar su registro: ningún socket queda huérfano sin dueño.
function closeCallSockets(c) {
  for (const name of ['user', 'dest']) {
    const leg = c.legs[name];
    if (!leg) continue;
    try { if (leg.oa) leg.oa.close(); } catch (e) {}
    try { if (leg.ws) leg.ws.close(); } catch (e) {}
  }
  if (c.maxTimer) { clearTimeout(c.maxTimer); c.maxTimer = null; }
}

/* Limpieza: ninguna llamada vive más de 6 horas en memoria. */
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of calls) {
    if (now - c.createdAt > 6 * 60 * 60 * 1000) {
      closeCallSockets(c);
      calls.delete(id);
    }
  }
  // Tope de memoria: si hay demasiadas, salen las más viejas ya listas.
  if (calls.size > 60) {
    const sorted = [...calls.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < sorted.length && calls.size > 60; i++) {
      if (sorted[i].ready) {
        closeCallSockets(sorted[i]);
        calls.delete(sorted[i].id);
      }
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log('[relay v6] Englix call relay en puerto ' + PORT +
    (OPENAI_KEY ? '' : ' — OJO: falta OPENAI_API_KEY'));
});
