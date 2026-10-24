// RETIRADO (auditoría 2026-10): este prototipo de traducción por
// turnos ya no lo usa el cliente — la conversación en vivo va por
// sesiones Realtime (api/rt-token.js) y el motor de frase completa
// (api/phrase.js). La ruta queda respondiendo 410 Gone a todo:
// push-files no puede borrar el archivo del repo, así que la
// función queda inerte y sin gasto de OpenAI.
module.exports = async (req, res) => {
  res.status(410).json({ ok: false, error: 'gone' });
};
