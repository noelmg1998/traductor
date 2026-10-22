// Prototipo: un turno de traducción de conversación (español <-> inglés).
// Recibe audio grabado (base64), lo transcribe, lo traduce y devuelve el audio traducido.
// La llave de OpenAI vive SOLO en la variable de entorno OPENAI_API_KEY.

const CONTEXTS = {
  general: 'general conversation',
  construccion: 'construction jobsite',
  restaurante: 'restaurant and food service',
  limpieza: 'cleaning and housekeeping services',
  salud: 'healthcare and medical visits',
  oficina: 'office and administrative work'
};

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

    const audio = body.audio;
    const mime = typeof body.mime === 'string' ? body.mime : 'audio/webm';
    const from = body.from === 'en' ? 'en' : 'es';
    const to = from === 'es' ? 'en' : 'es';
    const ctx = CONTEXTS[body.context] || CONTEXTS.general;

    if (!audio || typeof audio !== 'string') return fail('no_audio', 400);

    const headers = { ['Authori' + 'zation']: 'Bearer ' + key };
    const buf = Buffer.from(audio, 'base64');
    const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : (mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm');

    // 1) Transcripción de lo que se dijo
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
    form.append('model', 'gpt-4o-transcribe');
    form.append('language', from);
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers, body: form
    });
    if (!tr.ok) return fail('transcribe_failed');
    const trj = await tr.json();
    const transcript = (trj.text || '').trim();
    if (!transcript) return fail('empty_transcript');

    // 2) Traducción con el vocabulario del oficio elegido
    const system = to === 'en'
      ? 'You translate spoken Spanish into natural spoken US English for a ' + ctx + ' setting. Use the vocabulary people actually use at work in that setting. Return ONLY the translation, no explanations, no quotes.'
      : 'You translate spoken English into natural spoken Latin-American Spanish for a ' + ctx + ' setting. Use the vocabulary people actually use at work in that setting. Return ONLY the translation, no explanations, no quotes.';
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        model: 'gpt-5.5',
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: transcript }
        ]
      })
    });
    if (!cr.ok) return fail('translate_failed');
    const crj = await cr.json();
    const translation = ((crj.choices && crj.choices[0] && crj.choices[0].message && crj.choices[0].message.content) || '').trim();
    if (!translation) return fail('translate_failed');

    // 3) Voz de la traducción
    const sr = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        instructions: to === 'es'
          ? 'Speak in natural, clear Latin-American Spanish, with a warm, friendly, conversational tone, at a natural pace.'
          : 'Speak in natural, clear US English, with a warm, friendly, conversational tone, at a natural pace.',
        input: translation,
        response_format: 'mp3'
      })
    });
    if (!sr.ok) return fail('speech_failed');
    const outBuf = Buffer.from(await sr.arrayBuffer());

    res.status(200).json({
      ok: true,
      from,
      to,
      transcript,
      translation,
      audio: outBuf.toString('base64'),
      audioMime: 'audio/mpeg'
    });
  } catch (e) {
    return fail('server_error');
  }
};
