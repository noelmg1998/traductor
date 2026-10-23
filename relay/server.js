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
const { WebSocket, WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
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
  }
  return c;
}

/* ---------------- OpenAI Realtime por pata ---------------- */

function openSession(call, leg) {
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

  oa.on('open', () => {
    // La configuración se manda al recibir session.created (orden oficial).
  });

  oa.on('message', (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!ev || !ev.type) return;

    if (ev.type === 'session.created') {
      oa.send(JSON.stringify({
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
                interrupt_response: true
              }
            },
            output: { format: { type: 'audio/pcmu' }, voice: VOICE }
          }
        }
      }));
      leg.ready = true;
      return;
    }

    if (ev.type === 'response.output_audio.delta' && ev.delta) {
      // La voz traducida de ESTA pata suena en la pata contraria.
      const other = call.legs[leg.name === 'user' ? 'dest' : 'user'];
      if (other && other.ws && other.ws.readyState === WebSocket.OPEN && other.streamSid) {
        other.ws.send(JSON.stringify({
          event: 'media',
          streamSid: other.streamSid,
          media: { payload: ev.delta }
        }));
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
        ev.error && ev.error.message ? ev.error.message : ev);
    }
  });

  oa.on('error', (e) => console.error('[relay] openai ws error', call.id, leg.name, e.message));
  oa.on('close', () => { leg.ready = false; });
}

function flushPair(call, leg, transText) {
  call.pairs.push({
    orig: leg.pendingOrig || '',
    origLang: leg.hearLang,
    trans: transText || '',
    transLang: leg.speakLang
  });
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, calls: calls.size }));
    return;
  }
  const m = url.pathname.match(/^\/summary\/([A-Za-z0-9-]+)$/);
  if (m) {
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

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const legName = url.searchParams.get('leg') === 'dest' ? 'dest' : 'user';
  const callId = url.searchParams.get('callId') || '';
  if (!callId) { ws.close(); return; }

  const call = getCall(callId);
  const pa = url.searchParams.get('pairA');
  const pb = url.searchParams.get('pairB');
  if (LANG_OK.indexOf(pa) >= 0) call.pairA = pa;
  if (LANG_OK.indexOf(pb) >= 0 && pb !== call.pairA) call.pairB = pb;
  if (url.searchParams.get('goal')) call.goal = url.searchParams.get('goal').slice(0, 140);
  if (url.searchParams.get('dest')) call.dest = url.searchParams.get('dest');

  const leg = { name: legName, ws, streamSid: null, oa: null, ready: false };
  call.legs[legName] = leg;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.event) return;

    if (msg.event === 'start') {
      leg.streamSid = msg.start && msg.start.streamSid;
      if (OPENAI_KEY) openSession(call, leg);
      else console.error('[relay] falta OPENAI_API_KEY en el servidor');
      return;
    }
    if (msg.event === 'media') {
      if (leg.oa && leg.oa.readyState === WebSocket.OPEN && leg.ready) {
        leg.oa.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media && msg.media.payload
        }));
      }
      return;
    }
    if (msg.event === 'stop') {
      call.stopped += 1;
      try { if (leg.oa) leg.oa.close(); } catch (e) {}
      if (call.stopped >= 2) finalize(call);
      else setTimeout(() => finalize(call), 12000); // la otra pata puede tardar
      return;
    }
  });

  ws.on('close', () => {
    try { if (leg.oa) leg.oa.close(); } catch (e) {}
  });
  ws.on('error', () => {});
});

/* Limpieza: ninguna llamada vive más de 6 horas en memoria. */
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of calls) {
    if (now - c.createdAt > 6 * 60 * 60 * 1000) calls.delete(id);
  }
  // Tope de memoria: si hay demasiadas, salen las más viejas ya listas.
  if (calls.size > 60) {
    const sorted = [...calls.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < sorted.length && calls.size > 60; i++) {
      if (sorted[i].ready) calls.delete(sorted[i].id);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log('[relay] Englix call relay en puerto ' + PORT +
    (OPENAI_KEY ? '' : ' — OJO: falta OPENAI_API_KEY'));
});
