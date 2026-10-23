-- ============================================================
-- Englix · Cobro Fase 3b: idempotencia del webhook de Stripe
-- Pegar COMPLETO en el SQL Editor del proyecto «englix» y Run,
-- DESPUÉS de supabase-billing.sql y ANTES de activar las llaves
-- de Stripe (el webhook lo necesita desde el primer evento).
-- Seguro de re-ejecutar (idempotente).
--
-- Por qué existe esta tabla:
--   Stripe puede entregar el MISMO evento más de una vez (por
--   reintentos, por red, por lo que sea) y un evento de dinero
--   jamás puede aplicarse dos veces: una recarga acreditada al
--   doble es dinero regalado. El webhook (api/stripe-webhook.js)
--   RECLAMA cada evento antes de procesarlo: inserta su id en
--   esta tabla y solo sigue si el renglón se creó. Como
--   event_id es la llave primaria, la segunda entrega choca
--   contra la primera y el reclamo sale vacío: ese evento ya
--   se procesó y se responde «duplicate» sin tocar saldos.
--   Si el procesamiento falla DESPUÉS de reclamar, el webhook
--   borra el renglón antes de responder 500, pa' que el
--   reintento de Stripe pueda reclamarlo de nuevo.
--
-- Acceso: SOLO el servidor, con la llave de servicio
-- (service_role salta RLS por diseño de Supabase). La tabla
-- tiene RLS activado y NINGUNA policy: desde el cliente
-- (anon/authenticated) nadie la puede leer ni escribir.
-- ============================================================

create table if not exists public.stripe_events (
  event_id text primary key,
  type text,
  processed_at timestamptz not null default now()
);

alter table public.stripe_events enable row level security;

-- Sin policies a propósito (ver el encabezado): con RLS
-- activado y cero policies, anon y authenticated no pueden
-- tocar la tabla; el único acceso es el service role del
-- servidor, que es exactamente quien corre el webhook.

-- ============================================================
-- FIN. Orden de uso desde el servidor (api/stripe-webhook.js):
-- reclamar = insert con ignore-duplicates antes de procesar;
-- duplicado = reclamo vacío → 200 {received, duplicate:true};
-- fallo al procesar = borrar el renglón y responder 500.
-- ============================================================
