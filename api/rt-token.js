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

module.exports = async (req, res) => {
  const fail = (error, status) => {
    res.status(status || 200).json({ ok: false, error });
  };

  try {
    if (req.method !== 'POST') return fail('method', 405);

    const key = process.env.OPENAI_API_KEY;
    if (!key) return fail('missing_key');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

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
          model: 'gpt-realtime-whisper',
          languages: [pairA, pairB]
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
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
      if (!r.ok) return fail('token_failed');

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
