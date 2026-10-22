// Modo llamada (tiempo real): crea el secreto temporal (client secret) que el
// navegador usa para abrir UNA sesion de traduccion con gpt-realtime-translate.
// Cada sesion traduce a UN solo idioma de salida, asi que la pagina pide dos
// (una por sentido del par elegido). La llave real de OpenAI vive SOLO en la
// variable de entorno OPENAI_API_KEY y nunca llega al navegador.
//
// Sigue la guia oficial de OpenAI (Realtime Translation):
//   POST https://api.openai.com/v1/realtime/translations/client_secrets
//   body: { session: { model: "gpt-realtime-translate",
//           audio: { input:  { transcription: { model: "gpt-realtime-whisper" },
//                              noise_reduction: { type: "near_field" } },
//                    output: { language } } } }
// El cliente puede mandar noiseReduction:false para omitir la reduccion de
// ruido (ajuste de la pantalla; se aplica al crear la sesion).

const CLIENT_SECRET_URL =
  'https://api.openai.com/v1/realtime/translations/client_secrets';

// Los 13 idiomas que gpt-realtime-translate puede producir como salida.
const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

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

    const r = await fetch(CLIENT_SECRET_URL, {
      method: 'POST',
      headers: {
        ['Authori' + 'zation']: 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
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

    // La respuesta de OpenAI trae el secreto como texto o como objeto
    // { value, expires_at } segun la version; se normaliza aqui.
    let secret = null;
    let expiresAt = null;
    if (typeof j.client_secret === 'string') {
      secret = j.client_secret;
    } else if (j.client_secret && typeof j.client_secret.value === 'string') {
      secret = j.client_secret.value;
      expiresAt = j.client_secret.expires_at || null;
    } else if (typeof j.value === 'string') {
      secret = j.value;
      expiresAt = j.expires_at || null;
    }
    if (!secret) return fail('token_failed');

    res.status(200).json({
      ok: true,
      client_secret: secret,
      expires_at: expiresAt,
      language
    });
  } catch (e) {
    return fail('server_error');
  }
};
