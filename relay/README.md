# Englix — relay de llamadas (servidor de audio)

Puente en vivo entre Twilio Media Streams y OpenAI Realtime. Vercel no puede
sostener el audio de una llamada (sus funciones son sin estado); este
servidor sí, y SOLO hace eso: no guarda datos de usuarios, no usa
credenciales de Twilio. Su única llave es `OPENAI_API_KEY` (la misma de
Englix) como variable del servicio donde corra.

## Qué expone
- `WSS /stream?leg=user|dest&callId=..&pairA=es&pairB=en&goal=..` — audio.
- `GET /health` — `{ ok: true }`.
- `GET /summary/:callId` — estado y, al colgar, el resumen en español con la
  conversación (pares original → traducción).

## Despliegue (Fly.io, el camino previsto)
1. Noel crea la cuenta en fly.io (su paso: registro + tarjeta, como Twilio).
2. `fly launch --no-deploy` en esta carpeta (nombre: englix-relay).
3. `fly secrets set OPENAI_API_KEY=...` (la pega Noel o se reutiliza la de
   Vercel; nunca por el chat).
4. `fly deploy` — queda en `https://englix-relay.fly.dev` (wss en el mismo
   host, puerto interno 8080).
5. En Vercel (proyecto traductor-prueba): variable `CALL_RELAY_HOST` =
   `englix-relay.fly.dev` y redeploy. Desde ese momento el botón
   "Llamar con traductor" de la app funciona de verdad.

## Local
`npm install && OPENAI_API_KEY=... npm start` → escucha en `PORT` (8080).
