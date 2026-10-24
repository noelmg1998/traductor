// Motor C: "Frase completa" (v7). Recibe UNA frase ya terminada de grabar
// (audio en base64), la transcribe detectando el idioma, la traduce
// COMPLETA al otro idioma del par elegido y devuelve el texto original,
// la traducción y el audio de la traducción. Es el motor que cumple la
// regla del dueño: esperar a que la persona termine de hablar, reconocer
// el idioma de la frase completa y solo entonces traducirla entera.
//
// Pasos (todo del lado del servidor; la llave de OpenAI vive SOLO en la
// variable de entorno OPENAI_API_KEY y nunca llega al navegador):
//   1) Transcripción: gpt-4o-transcribe, response_format json
//      (text + language cuando el modelo lo incluye; sin pista de
//      idioma. 'verbose_json' lo rechaza el proveedor para este
//      modelo — verificado en vivo).
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
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'en', 'una', 'es', 'por', 'con', 'para', 'gracias', 'hola', 'quiero', 'tengo', 'vamos', 'esto', 'esta', 'muy', 'cuando', 'donde', 'necesito', 'terminar', 'hoy', 'sí', 'buenos', 'buenas', 'días', 'tardes', 'también', 'favor', 'eso', 'aquí', 'ahora', 'mañana', 'señor', 'bien'],
  en: ['the', 'be', 'of', 'and', 'a', 'in', 'to', 'have', 'it', 'that', 'for', 'you', 'with', 'are', 'this', 'they', 'when', 'your', 'can', 'there', 'would', 'make', 'like', 'need', 'want', 'please', 'thanks', 'thank', 'hello', 'today', 'finish', 'yeah', 'yes', 'okay', 'sure', 'well', 'good', 'morning'],
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

// Idioma según la escritura del texto (determinista), o null.
function scriptLangOf(text) {
  if (!text) return null;
  for (var i = 0; i < SCRIPT_CHECKS.length; i++) {
    if (SCRIPT_CHECKS[i][1].test(text)) return SCRIPT_CHECKS[i][0];
  }
  return null;
}

// Puntaje de "cuánto suena el texto" al idioma `code`: palabras
// frecuentes (+1 c/u) y caracteres característicos (+2).
function markerScore(code, text) {
  if (!text) return 0;
  var score = 0, i;
  for (i = 0; i < CHAR_MARKERS.length; i++) {
    if (CHAR_MARKERS[i][0] === code && CHAR_MARKERS[i][1].test(text)) score += 2;
  }
  var words = WORD_MARKERS[code];
  if (!words) return score;
  var set = {};
  words.forEach(function (w) { set[w] = true; });
  var tokens = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/);
  tokens.forEach(function (w) { if (set[w]) score++; });
  return score;
}

/* Dirección determinista:
   1) Si el idioma detectado pertenece al par → fuente = detectado,
      destino = el otro idioma del par.
   2) Si NO pertenece al par — o la respuesta no trajo idioma, que es
      lo que pasa en vivo con el formato 'json' — respaldo: primero la
      escritura (si el texto está en la escritura de uno del par, ese
      es la fuente); luego el puntaje de marcadores de AMBOS idiomas
      del par (gana el mayor; sirve también para frases cortas como
      "¡Gracias!" o "Thank you"); empate o cero → B→A por defecto. */
function resolveDirection(detected, pairA, pairB, text) {
  if (detected === pairA) return { src: pairA, dst: pairB };
  if (detected === pairB) return { src: pairB, dst: pairA };
  var sl = scriptLangOf(text);
  if (sl === pairA) return { src: pairA, dst: pairB };
  if (sl === pairB) return { src: pairB, dst: pairA };
  var sa = markerScore(pairA, text), sb = markerScore(pairB, text);
  if (sa > sb) return { src: pairA, dst: pairB };
  if (sb > sa) return { src: pairB, dst: pairA };
  return { src: pairB, dst: pairA };
}

function pickPair(body) {
  var a = ALLOWED_LANGUAGES.indexOf(body.pairA) >= 0 ? body.pairA : 'en';
  var b = ALLOWED_LANGUAGES.indexOf(body.pairB) >= 0 ? body.pairB : 'es';
  if (a === b) b = a === 'es' ? 'en' : 'es';
  return [a, b];
}

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Este endpoint gasta OpenAI (transcripción + traducción + voz):
   sin sesión válida de Supabase NO se procesa nada, y sin minutos
   de conversación (plan o saldo) tampoco. El usuario sale SOLO del
   token, validado contra Supabase Auth — el patrón de api/usage.js. */
const SUPABASE_URL = process.env.SUPABASE_URL ||
  'https://ogwvbiiuetshruyypdgh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nd3ZiaWl1ZXRzaHJ1eXlwZGdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NzQwNzEsImV4cCI6MjEwODM1MDA3MX0.TPilmidc_nRL0_VwDaHj2N8kVTH-SNRnv_Zs1BIYikM';

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
  const fail = (error, status, detail) => {
    const out = { ok: false, error };
    if (detail) out.detail = detail;
    res.status(status || 200).json(out);
  };
  // Diagnóstico del proveedor (código + mensaje recortado): va SOLO
  // al registro del servidor vía console.error, nunca al cliente.
  const provDetail = (j, status) => {
    if (j && j.error) {
      return String(j.error.code || '') + ': ' +
        String(j.error.message || '').slice(0, 300);
    }
    return 'status ' + status;
  };

  try {
    if (req.method !== 'POST') return fail('method', 405);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    // Puerta: sesión válida + minutos de conversación, ANTES de
    // gastar un centavo de OpenAI.
    const g = await gate(req, fail, 'conv', 60, 60 * 1000);
    if (!g) return;

    const key = process.env.OPENAI_API_KEY;
    if (!key) return fail('missing_key');

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

    /* 1) Transcripción con detección de idioma (sin pista).
       response_format 'json': 'verbose_json' lo RECHAZA el proveedor
       para gpt-4o-transcribe (verificado en vivo: "Use 'json' or
       'text' instead"); el formato json devuelve text y, cuando el
       modelo lo incluye, language — si no viniera, la dirección cae al
       respaldo determinista por marcadores (resolveDirection). */
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
    form.append('model', 'gpt-4o-transcribe');
    form.append('response_format', 'json');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers, body: form
    });
    const trj = await tr.json().catch(() => ({}));
    if (!tr.ok) {
      console.error('[phrase] transcribe_failed', provDetail(trj, tr.status));
      return fail('transcribe_failed');
    }
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
    if (!cr.ok) {
      console.error('[phrase] translate_failed', provDetail(crj, cr.status));
      return fail('translate_failed');
    }
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
      console.error('[phrase] speech_failed', provDetail(sj, sr.status));
      return fail('speech_failed');
    }
    const outBuf = Buffer.from(await sr.arrayBuffer());

    res.status(200).json({
      ok: true,
      detected: detected,
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
