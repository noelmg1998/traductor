// Modo llamada (tiempo real): crea el secreto temporal (client secret) que el
// navegador usa para abrir sesiones con OpenAI. Hay DOS motores:
//
// A) "translate" (traductor dedicado): POST a
//    /v1/realtime/translations/client_secrets con gpt-realtime-translate.
//    Cada sesion traduce a UN solo idioma de salida, asi que la pagina pide
//    dos (una por sentido del par elegido).
//
// B) "interpreter" (intérprete conversacional, v6): POST a
//    /v1/realtime/client_secrets con una sesion "realtime" de
//    gpt-realtime-2.1-mini. UNA sola sesion con las instrucciones de
//    intérprete fijadas AQUI (del lado del servidor, como manda la
//    documentación oficial: lo que el cliente pudiera mandar por
//    session.update queda bajo su control, así que las instrucciones que
//    importan se fijan al crear el secreto).
//
// Campos verificados contra la documentación oficial de OpenAI
// (API Reference → Realtime → Client Secrets, y la guía
// "Realtime conversations"):
//   body: { expires_after: { anchor: "created_at", seconds },
//           session: { type: "realtime", model, instructions,
//                      output_modalities: ["audio"],
//                      audio: { input: { transcription: { model, languages },
//                                        noise_reduction: { type },
//                                        turn_detection: { type: "server_vad",
//                                          threshold, prefix_padding_ms,
//                                          silence_duration_ms, create_response,
//                                          interrupt_response } },
//                               output: { voice } } } }
//   Con output_modalities ["audio"] el modelo responde audio MÁS su
//   transcripción (response.output_audio_transcript.*); la referencia
//   indica que no se pueden pedir "text" y "audio" a la vez.
//   Respuesta: { value: "ek_...", expires_at, session: {...} }.
//
// La llave real de OpenAI vive SOLO en la variable de entorno
// OPENAI_API_KEY y nunca llega al navegador.

const TRANSLATE_SECRET_URL =
  'https://api.openai.com/v1/realtime/translations/client_secrets';
const INTERP_SECRET_URL =
  'https://api.openai.com/v1/realtime/client_secrets';
const INTERP_MODEL = 'gpt-realtime-2.1-mini';

// Los 13 idiomas que el sistema puede producir como salida.
const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

// Nombres en inglés de cada idioma (para las instrucciones del intérprete).
const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', hi: 'Hindi', ru: 'Russian', id: 'Indonesian'
};

// Voces válidas de las sesiones Realtime conversacionales (doc. oficial).
const ALLOWED_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse',
  'marin', 'cedar'
];

// Instrucciones del intérprete: se arman con los nombres de los dos
// idiomas del par elegido. Plantilla fija aprobada por el dueño.
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

// La respuesta de OpenAI trae el secreto como texto, como objeto
// { value, expires_at } o bajo la clave client_secret segun la version;
// se normaliza aqui.
function pickSecret(j) {
  if (!j) return { secret: null, expiresAt: null };
  if (typeof j.client_secret === 'string') {
    return { secret: j.client_secret, expiresAt: j.expires_at || null };
  }
  if (j.client_secret && typeof j.client_secret.value === 'string') {
    return {
      secret: j.client_secret.value,
      expiresAt: j.client_secret.expires_at || null
    };
  }
  if (typeof j.value === 'string') {
    return { secret: j.value, expiresAt: j.expires_at || null };
  }
  return { secret: null, expiresAt: null };
}

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Este endpoint crea secretos de OpenAI (costo real): sin sesión
   válida de Supabase NO se crea nada, y sin minutos de conversación
   (plan o saldo) tampoco. El usuario sale SOLO del token, validado
   contra Supabase Auth — el mismo patrón de api/usage.js. */
const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

// Valida el access token contra Supabase Auth y devuelve el
// usuario ({ id, email }) o null.
async function userFromToken(token) {
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      ['Authori' + 'zation']: 'Bearer ' + token
    }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  return u;
}

// Llamada REST con la llave de servicio (salta RLS: solo el
// servidor la tiene, y el user_id siempre sale del token).
async function svc(path, options) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(SUPABASE_URL + path, Object.assign({}, options || {}, {
    headers: Object.assign({
      apikey: key,
      ['Authori' + 'zation']: 'Bearer ' + key,
      'Content-Type': 'application/json'
    }, (options && options.headers) || {})
  }));
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

async function readEntitlements(userId) {
  const q = '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(userId) +
    '&select=user_id,plan,plan_conv_seconds,plan_call_seconds,balance_cents,cycle_ends_at&limit=1';
  const r = await svc(q);
  if (!r.ok) return null;
  const row = Array.isArray(r.json) && r.json.length ? r.json[0] : null;
  return row || {
    user_id: userId, plan: 'free',
    plan_conv_seconds: 0, plan_call_seconds: 0,
    balance_cents: 0, cycle_ends_at: null
  };
}

// Segundos disponibles de un tipo: los del plan + los que el saldo
// compra a su tarifa ($0.10/min conversación, $0.15/min llamada).
function availableSeconds(ent, kind) {
  if (kind === 'conv') {
    return (ent.plan_conv_seconds || 0) +
      Math.floor((ent.balance_cents || 0) / 10) * 60;
  }
  return (ent.plan_call_seconds || 0) +
    Math.floor((ent.balance_cents || 0) / 15) * 60;
}

// Limitador en memoria por usuario+IP (best-effort: vive en la
// instancia de la función; frena el abuso básico, no es un límite
// global entre instancias).
const rlBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    rlBuckets.set(key, b);
  }
  b.count += 1;
  if (rlBuckets.size > 5000) rlBuckets.clear();
  return b.count > max;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '?';
}

// Puerta completa: sesión (401) → límite (429) → minutos del tipo
// pedido (402). Si algo falla, responde el error y devuelve null.
async function gate(req, fail, kind, rlMax, rlWindowMs) {
  const auth = String(req.headers.authorization || req.headers.Authorization || '');
  const token = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
  if (!token) { fail('unauthorized', 401); return null; }
  const user = await userFromToken(token).catch(() => null);
  if (!user) { fail('unauthorized', 401); return null; }
  if (rateLimited(user.id + '|' + clientIp(req), rlMax, rlWindowMs)) {
    fail('rate_limited', 429); return null;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    fail('billing_not_configured', 503); return null;
  }
  const ent = await readEntitlements(user.id);
  if (!ent) { fail('db_error', 503); return null; }
  if (availableSeconds(ent, kind) <= 0) {
    fail('no_minutes', 402); return null;
  }
  return { user, ent };
}

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method', 405);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    // Puerta: sesión válida + minutos de conversación, ANTES de
    // crear cualquier secreto de OpenAI.
    const g = await gate(req, fail, 'conv', 60, 60 * 1000);
    if (!g) return;

    const key = process.env.OPENAI_API_KEY;
    if (!key) return fail('missing_key');

    const headers = {
      ['Authori' + 'zation']: 'Bearer ' + key,
      'Content-Type': 'application/json'
    };

    /* ---------- Motor B: intérprete conversacional (v6) ---------- */
    if (body.engine === 'interpreter') {
      let pairA = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'en';
      let pairB = ALLOWED_LANGUAGES.indexOf(body.pairB) >= 0 ? body.pairB : 'es';
      if (pairA === pairB) pairB = pairA === 'es' ? 'en' : 'es';
      const voice = ALLOWED_VOICES.indexOf(body.voice) >= 0 ? body.voice : 'marin';

      const inputAudio = {
        transcription: {
          // Sin "languages": OpenAI lo rechaza para gpt-realtime-whisper
          // ("The 'languages' parameter is not supported for this
          // model", verificado en vivo); detecta el idioma solo.
          model: 'gpt-realtime-whisper'
        },
        turn_detection: {
          // Regla "esperar al final": el intérprete NO traduce hasta que
          // la persona TERMINA la frase — silencio de ~1.1 s para cerrar
          // el turno y umbral más alto contra disparos por ruido.
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 1100,
          create_response: true,
          interrupt_response: true
        }
      };
      if (body.noiseReduction !== false) {
        inputAudio.noise_reduction = { type: 'near_field' };
      }

      const r = await fetch(INTERP_SECRET_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: 300 },
          session: {
            type: 'realtime',
            model: INTERP_MODEL,
            instructions: interpreterInstructions(
              LANG_NAMES[pairA], LANG_NAMES[pairB]
            ),
            output_modalities: ['audio'],
            audio: {
              input: inputAudio,
              output: { voice }
            }
          }
        })
      });

      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // El detalle del proveedor queda SOLO en el registro del
        // servidor; al cliente va un error genérico (auditoría 2026-10).
        const detail = j && j.error
          ? String(j.error.code || '') + ': ' + String(j.error.message || '').slice(0, 300)
          : 'status ' + r.status;
        console.error('[rt-token] openai', detail);
        return fail('token_failed');
      }

      const picked = pickSecret(j);
      if (!picked.secret) return fail('token_failed');

      res.status(200).json({
        ok: true,
        engine: 'interpreter',
        client_secret: picked.secret,
        expires_at: picked.expiresAt,
        pair: [pairA, pairB],
        voice
      });
      return;
    }

    /* ---------- Motor A: traductor dedicado (sin cambios) ---------- */
    const language = ALLOWED_LANGUAGES.indexOf(body.targetLanguage) >= 0
      ? body.targetLanguage
      : null;
    if (!language) return fail('bad_language', 400);

    const inputAudio = {
      transcription: { model: 'gpt-realtime-whisper' }
    };
    if (body.noiseReduction !== false) {
      inputAudio.noise_reduction = { type: 'near_field' };
    }

    const r = await fetch(TRANSLATE_SECRET_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            input: inputAudio,
            output: { language }
          }
        }
      })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail('token_failed');

    const picked = pickSecret(j);
    if (!picked.secret) return fail('token_failed');

    res.status(200).json({
      ok: true,
      client_secret: picked.secret,
      expires_at: picked.expiresAt,
      language
    });
  } catch (e) {
    return fail('server_error');
  }
};
