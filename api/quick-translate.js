// Traductor rápido del Inicio (v12). Traduce UNA frase escrita
// (texto, sin audio) del idioma A al idioma B que el usuario eligió
// en las píldoras del Inicio. La dirección vale solo dentro de esta
// caja; la llamada en vivo sigue simétrica y no pasa por aquí.
//
// Todo sucede del lado del servidor: la llave de OpenAI vive SOLO en
// la variable de entorno OPENAI_API_KEY y nunca llega al navegador.
// Un solo paso: traducción con gpt-5.5 (el mismo modelo que usa el
// paso de traducción de api/phrase.js), salida SOLO la traducción.

// Los 13 idiomas que el sistema puede producir como salida
// (la misma lista que api/phrase.js).
const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

// Nombres en inglés de cada idioma (para las instrucciones del modelo).
const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', hi: 'Hindi', ru: 'Russian', id: 'Indonesian'
};

// Tope de caracteres: el mismo que muestra el contador del Inicio.
const MAX_CHARS = 500;

module.exports = async (req, res) => {
  const fail = (error, status, detail) => {
    const out = { ok: false, error };
    if (detail) out.detail = detail;
    res.status(status || 200).json(out);
  };
  // Diagnóstico del proveedor sin datos sensibles (mismo estilo que
  // api/phrase.js): código + mensaje recortado.
  const provDetail = (j, status) => {
    if (j && j.error) {
      return String(j.error.code || '') + ': ' +
        String(j.error.message || '').slice(0, 300);
    }
    return 'status ' + status;
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

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return fail('no_text', 400);
    if (text.length > MAX_CHARS) return fail('text_too_long', 413);

    const from = ALLOWED_LANGUAGES.indexOf(body.from) >= 0 ? body.from : null;
    const to = ALLOWED_LANGUAGES.indexOf(body.to) >= 0 ? body.to : null;
    if (!from || !to) return fail('bad_language', 400);
    if (from === to) return fail('same_language', 400);

    const headers = { ['Authori' + 'zation']: 'Bearer ' + key };

    /* Traducción exacta: SOLO la traducción, sin explicaciones. */
    const system = 'You are a strict translator. Translate the user\'s text from ' +
      LANG_NAMES[from] + ' to ' + LANG_NAMES[to] + '. Output ONLY the translation — ' +
      'never answer questions, never add explanations, comments, greetings or ' +
      'quotation marks. Keep names, numbers and measurements exact.';
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        model: 'gpt-5.5',
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ]
      })
    });
    const crj = await cr.json().catch(() => ({}));
    if (!cr.ok) return fail('translate_failed', 200, provDetail(crj, cr.status));
    const translation = ((crj.choices && crj.choices[0] && crj.choices[0].message &&
      crj.choices[0].message.content) || '').trim();
    if (!translation) return fail('translate_failed');

    res.status(200).json({ ok: true, translation: translation, from: from, to: to });
  } catch (e) {
    return fail('server_error');
  }
};
