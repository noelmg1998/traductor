// Motor C: "Frase completa" (v7). Recibe UNA frase ya terminada de grabar
// (audio en base64), la transcribe detectando el idioma, la traduce
// COMPLETA al otro idioma del par elegido y devuelve el texto original,
// la traducción y el audio de la traducción. Es el motor que cumple la
// regla del dueño: esperar a que la persona termine de hablar, reconocer
// el idioma de la frase completa y solo entonces traducirla entera.
//
// Pasos (todo del lado del servidor; la llave de OpenAI vive SOLO en la
// variable de entorno OPENAI_API_KEY y nunca llega al navegador):
//   1) Transcripción: gpt-4o-transcribe, response_format verbose_json
//      (devuelve text + language detectado, sin pista de idioma).
//   2) Dirección determinista (ver resolveDirection abajo).
//   3) Traducción: gpt-5.5, salida SOLO la traducción.
//   4) Voz: gpt-4o-mini-tts con la voz elegida en Ajustes (validada
//      contra la lista conocida; si no es válida, 'marin').

// Los 13 idiomas que el sistema puede producir como salida.
const ALLOWED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'zh', 'ja', 'ko', 'ar', 'hi', 'ru', 'id'
];

// Nombres en inglés de cada idioma (para las instrucciones de los modelos).
const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', hi: 'Hindi', ru: 'Russian', id: 'Indonesian'
};

// gpt-4o-transcribe (verbose_json) puede devolver el idioma como nombre
// completo en inglés ("spanish") o como código ISO ("es"): se aceptan
// ambos. Mapa nombre -> código para los 13 del sistema.
const LANG_NAME_TO_CODE = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
  portuguese: 'pt', chinese: 'zh', mandarin: 'zh', japanese: 'ja',
  korean: 'ko', arabic: 'ar', hindi: 'hi', russian: 'ru', indonesian: 'id',
  'bahasa indonesia': 'id'
};

// Voces válidas (la misma lista conocida de Ajustes / sesiones Realtime).
const ALLOWED_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse',
  'marin', 'cedar'
];

// Normaliza lo que devuelva el transcriptor a un código de ALLOWED_LANGUAGES
// (o null si no se reconoce).
function normLang(raw) {
  if (!raw) return null;
  var s = String(raw).toLowerCase().trim();
  if (ALLOWED_LANGUAGES.indexOf(s) >= 0) return s;
  if (LANG_NAME_TO_CODE[s]) return LANG_NAME_TO_CODE[s];
  var base = s.split(/[-_]/)[0];
  if (ALLOWED_LANGUAGES.indexOf(base) >= 0) return base;
  if (LANG_NAME_TO_CODE[base]) return LANG_NAME_TO_CODE[base];
  return null;
}

/* ---- Marcadores deterministas de "a qué idioma suena el texto" ----
   Solo se usan como RESPALDO cuando el idioma detectado NO pertenece
   al par elegido. Primero la escritura (determinista), luego palabras
   frecuentes de cada idioma. */
const SCRIPT_CHECKS = [
  ['ja', /[\u3040-\u30FF]/],            // hiragana/katakana
  ['ko', /[\uAC00-\uD7AF]/],            // hangul
  ['zh', /[\u4E00-\u9FFF]/],            // han (sin kana ni hangul)
  ['ru', /[\u0400-\u04FF]/],            // cirílico
  ['hi', /[\u0900-\u097F]/],            // devanagari
  ['ar', /[\u0600-\u06FF]/]             // árabe
];
const WORD_MARKERS = {
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'en', 'una', 'es', 'por', 'con', 'para', 'gracias', 'hola', 'quiero', 'tengo', 'vamos', 'esto', 'esta', 'muy', 'cuando', 'donde', 'necesito', 'terminar', 'hoy'],
  en: ['the', 'be', 'of', 'and', 'a', 'in', 'to', 'have', 'it', 'that', 'for', 'you', 'with', 'are', 'this', 'they', 'when', 'your', 'can', 'there', 'would', 'make', 'like', 'need', 'want', 'please', 'thanks', 'hello', 'today', 'finish'],
  fr: ['le', 'la', 'les', 'de', 'des', 'est', 'je', 'tu', 'nous', 'vous', 'merci', 'bonjour', 'avec', 'pour', 'une', 'dans', 'pas', 'qui', 'sur', 'plus', 'être', 'avoir'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'haben', 'werden', 'danke', 'auch', 'sich', 'nach', 'bei', 'einen'],
  it: ['il', 'lo', 'gli', 'che', 'di', 'non', 'una', 'per', 'sono', 'grazie', 'ciao', 'con', 'del', 'della', 'anche', 'questo', 'questa', 'come', 'più'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'não', 'um', 'uma', 'para', 'com', 'obrigado', 'obrigada', 'você', 'também', 'isso', 'este', 'esta', 'muito'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'saya', 'tidak', 'ada', 'untuk', 'dengan', 'dari', 'akan', 'sudah', 'terima', 'kasih', 'selamat', 'bisa', 'pada', 'orang']
};
const CHAR_MARKERS = [
  ['es', /[¿¡ñ]/i],
  ['de', /[äöüß]/i],
  ['pt', /[ãõ]/i],
  ['fr', /[àâçéèêëîïôû]/i]
];

// ¿El texto "suena" al idioma `code`? (booleano, determinista)
function looksLike(code, text) {
  if (!text) return false;
  var i, m;
  for (i = 0; i < SCRIPT_CHECKS.length; i++) {
    if (SCRIPT_CHECKS[i][1].test(text)) return SCRIPT_CHECKS[i][0] === code;
  }
  for (i = 0; i < CHAR_MARKERS.length; i++) {
    m = CHAR_MARKERS[i];
    if (m[1].test(text)) {
      // 'es' gana con ¿¡ñ; los demás caracteres acentuados solo cuentan
      // si coinciden con el idioma preguntado y no son de español.
      if (m[0] === code) return true;
      if (m[0] === 'es') return false;
    }
  }
  var words = WORD_MARKERS[code];
  if (!words) return false;
  var set = {};
  words.forEach(function (w) { set[w] = true; });
  var tokens = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/);
  var hits = 0;
  tokens.forEach(function (w) { if (set[w]) hits++; });
  return hits >= 2;
}

/* Dirección determinista:
   1) Si el idioma detectado pertenece al par → fuente = detectado,
      destino = el otro idioma del par.
   2) Si NO pertenece al par (o no se pudo normalizar) → respaldo: si el
      texto "suena" al idioma A del par (looksLike), se traduce A→B;
      en cualquier otro caso se traduce B→A (fuente supuesta = B). */
function resolveDirection(detected, pairA, pairB, text) {
  if (detected === pairA) return { src: pairA, dst: pairB };
  if (detected === pairB) return { src: pairB, dst: pairA };
  if (looksLike(pairA, text)) return { src: pairA, dst: pairB };
  return { src: pairB, dst: pairA };
}

function pickPair(body) {
  var a = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'en';
  var b = ALLOWED_LANGUAGES.indexOf(body.pairB) >= 0 ? body.pairB : 'es';
  if (a === b) b = a === 'es' ? 'en' : 'es';
  return [a, b];
}

module.exports = async (req, res) => {
  const fail = (error, status, detail) => {
    const out = { ok: false, error };
    if (detail) out.detail = detail;
    res.status(status || 200).json(out);
  };
  // Diagnóstico del proveedor sin datos sensibles (mismo estilo que
  // api/rt-token.js): código + mensaje recortado.
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

    const audio = body.audio;
    if (!audio || typeof audio !== 'string') return fail('no_audio', 400);
    const buf = Buffer.from(audio, 'base64');
    if (!buf.length) return fail('no_audio', 400);
    if (buf.length > 12 * 1024 * 1024) return fail('audio_too_large', 413);

    const pair = pickPair(body);
    const pairA = pair[0], pairB = pair[1];
    const voice = ALLOWED_VOICES.indexOf(body.voice) >= 0 ? body.voice : 'marin';
    const mime = typeof body.mime === 'string' ? body.mime : 'audio/webm';
    const ext = mime.indexOf('mp4') >= 0 ? 'm4a'
      : (mime.indexOf('ogg') >= 0 ? 'ogg'
      : (mime.indexOf('wav') >= 0 ? 'wav' : 'webm'));

    const headers = { ['Authori' + 'zation']: 'Bearer ' + key };

    /* 1) Transcripción con detección de idioma (sin pista) */
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
    form.append('model', 'gpt-4o-transcribe');
    form.append('response_format', 'verbose_json');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers, body: form
    });
    const trj = await tr.json().catch(() => ({}));
    if (!tr.ok) return fail('transcribe_failed', 200, provDetail(trj, tr.status));
    const srcText = (trj.text || '').trim();
    if (!srcText) {
      // Silencio o ruido sin palabras: el cliente descarta sin tarjeta.
      res.status(200).json({ ok: true, empty: true });
      return;
    }

    /* 2) Dirección */
    const detected = normLang(trj.language);
    const dir = resolveDirection(detected, pairA, pairB, srcText);
    const srcName = LANG_NAMES[dir.src], dstName = LANG_NAMES[dir.dst];

    /* 3) Traducción completa con el modelo grande */
    const system = 'You are a strict translator. Translate the user\'s text from ' +
      srcName + ' to ' + dstName + '. Output ONLY the translation — never answer ' +
      'questions, never add explanations, comments, greetings or quotation marks. ' +
      'Preserve the speaker\'s tone and register, including colloquial and ' +
      'jobsite speech. Keep names, numbers and measurements exact.';
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        model: 'gpt-5.5',
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: srcText }
        ]
      })
    });
    const crj = await cr.json().catch(() => ({}));
    if (!cr.ok) return fail('translate_failed', 200, provDetail(crj, cr.status));
    const dstText = ((crj.choices && crj.choices[0] && crj.choices[0].message &&
      crj.choices[0].message.content) || '').trim();
    if (!dstText) return fail('translate_failed');

    /* 4) Voz de la traducción */
    const sr = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: voice,
        instructions: 'Speak in natural, clear ' + dstName +
          ', with a warm, friendly, conversational tone, at a natural pace.',
        input: dstText,
        response_format: 'mp3'
      })
    });
    if (!sr.ok) {
      const sj = await sr.json().catch(() => ({}));
      return fail('speech_failed', 200, provDetail(sj, sr.status));
    }
    const outBuf = Buffer.from(await sr.arrayBuffer());

    res.status(200).json({
      ok: true,
      srcLang: dir.src,
      srcText: srcText,
      dstLang: dir.dst,
      dstText: dstText,
      audioBase64: outBuf.toString('base64'),
      audioMime: 'audio/mpeg',
      voice: voice
    });
  } catch (e) {
    return fail('server_error');
  }
};
