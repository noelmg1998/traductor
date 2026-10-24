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

/* ---- Puerta de seguridad (auditoría 2026-10) ----
   Este endpoint gasta OpenAI: sin sesión válida de Supabase NO se
   traduce nada, y sin minutos de conversación (plan o saldo)
   tampoco. El usuario sale SOLO del token, validado contra
   Supabase Auth — el mismo patrón de api/usage.js. */
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
    if (!cr.ok) {
      console.error('[quick-translate] translate_failed', provDetail(crj, cr.status));
      return fail('translate_failed');
    }
    const translation = ((crj.choices && crj.choices[0] && crj.choices[0].message &&
      crj.choices[0].message.content) || '').trim();
    if (!translation) return fail('translate_failed');

    res.status(200).json({ ok: true, translation: translation, from: from, to: to });
  } catch (e) {
    return fail('server_error');
  }
};
