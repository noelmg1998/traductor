-- ============================================================
-- Englix · Cobro: planes + saldo (Fase 1, 2026-10-23)
-- Pegar COMPLETO en el SQL Editor del proyecto «englix» y Run,
-- DESPUÉS de supabase-auth.sql. Seguro de re-ejecutar (idempotente).
--
-- Modelo decidido por Noel (no rediseñar):
--   · Planes mensuales como producto principal + saldo prepago
--     pa' los extras.
--   · Conversación en persona: $0.10 por minuto de VOZ hablada
--     (6 segundos por centavo) — nunca por tiempo conectado.
--   · Llamada telefónica: $0.15 por minuto de llamada
--     (4 segundos por centavo).
--   · Planes: basico $9.99 = 3600 s conv + 1800 s llamada;
--     plus $19.99 = 7200 s + 3600 s; premium $29.99 = 10800 s
--     + 6000 s. Los minutos del plan NO se acumulan: al renovar
--     el ciclo, las cubetas vuelven a su monto completo.
--   · Orden de consumo: primero la cubeta del plan, después el
--     saldo. El saldo no se vence.
--   · Bienvenida al registrarse: 600 s de conversación.
--
-- TODO el dinero se mueve SOLO desde el servidor (funciones
-- RPC con security definer, ejecutables únicamente por el
-- service role). El cliente solo LEE su fila: nadie puede
-- darse minutos ni saldo desde el navegador.
-- ============================================================

-- ---------- 1) Ampliar entitlements ----------
-- El check original de `plan` solo permitía ('free','premium'):
-- se reemplaza por la lista completa de planes.
alter table public.entitlements drop constraint if exists entitlements_plan_check;
alter table public.entitlements
  add constraint entitlements_plan_check
  check (plan in ('free','basico','plus','premium'));

-- Cubetas del plan (segundos que quedan en el ciclo) y saldo.
-- La columna vieja minutes_balance queda intacta (legado).
alter table public.entitlements
  add column if not exists plan_conv_seconds integer not null default 0
    check (plan_conv_seconds >= 0);
alter table public.entitlements
  add column if not exists plan_call_seconds integer not null default 0
    check (plan_call_seconds >= 0);
alter table public.entitlements
  add column if not exists balance_cents integer not null default 0
    check (balance_cents >= 0);
alter table public.entitlements
  add column if not exists cycle_ends_at timestamptz;
alter table public.entitlements
  add column if not exists stripe_customer_id text;
alter table public.entitlements
  add column if not exists stripe_subscription_id text;

-- ---------- 2) Libro de movimientos (usage_ledger) ----------
-- Cada segundo y cada centavo que entra o sale queda anotado:
-- de aquí salen los reportes y la resolución de reclamos.
create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in (
    'welcome',      -- regalo de bienvenida (segundos)
    'plan_conv',    -- consumo de la cubeta de conversación del plan
    'plan_call',    -- consumo de la cubeta de llamadas del plan
    'balance_conv', -- consumo pagado con saldo (conversación)
    'balance_call', -- consumo pagado con saldo (llamada)
    'topup',        -- recarga de saldo (centavos)
    'plan_grant'    -- otorgamiento/renovación de un plan (segundos)
  )),
  seconds_delta integer not null default 0,
  cents_delta integer not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_ledger_user_created_idx
  on public.usage_ledger (user_id, created_at desc);

alter table public.usage_ledger enable row level security;

-- El cliente solo LEE sus movimientos; nadie escribe desde el cliente.
drop policy if exists "usage_ledger_select_own" on public.usage_ledger;
create policy "usage_ledger_select_own" on public.usage_ledger
  for select using (auth.uid() = user_id);

-- ---------- 3) Alta con bienvenida (600 s de conversación) ----------
-- Misma función de supabase-auth.sql + el regalo de bienvenida:
-- la fila de entitlements nace con plan_conv_seconds = 600 y el
-- movimiento queda anotado en el ledger como 'welcome'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, terms_version, terms_accepted_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.email, ''),
    new.raw_user_meta_data ->> 'terms_version',
    case when (new.raw_user_meta_data ->> 'terms_accepted_at') is not null
         then (new.raw_user_meta_data ->> 'terms_accepted_at')::timestamptz end
  )
  on conflict (id) do nothing;

  insert into public.entitlements (user_id, plan, minutes_balance, plan_conv_seconds)
  values (new.id, 'free', 0, 600)
  on conflict (user_id) do nothing;

  -- El regalo solo se anota cuando la fila nació aquí (si la fila
  -- ya existía, el on conflict de arriba no insertó nada).
  if found then
    insert into public.usage_ledger (user_id, kind, seconds_delta, cents_delta, meta)
    values (new.id, 'welcome', 600, 0, '{"source":"signup"}'::jsonb);
  end if;

  return new;
end;
$$;

-- (El trigger on_auth_user_created de supabase-auth.sql ya apunta
-- a esta función; no hace falta recrearlo.)

-- ---------- 4) Función interna: asegurar la fila de derechos ----------
-- Las RPC la usan para que un usuario sin fila (registro anterior
-- a esta fase) opere con una fila free en ceros, sin bienvenida.
create or replace function public.ensure_entitlements(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.entitlements (user_id)
  values (p_user)
  on conflict (user_id) do nothing;
end;
$$;

-- ---------- 5) RPC: consumir segundos (ATÓMICA) ----------
-- Descuenta primero de la cubeta del plan que corresponda
-- (conv/call) y el resto del saldo, convirtiendo a centavos a
-- 6 s/¢ (conversación) o 4 s/¢ (llamada), redondeando HACIA
-- ARRIBA el último centavo parcial. Si no alcanza en ningún
-- lado, descuenta lo que haya y reporta el faltante (shortfall)
-- en segundos. Todo en UNA transacción con la fila bloqueada.
-- Devuelve los totales nuevos para que la app pinte sin re-leer.
create or replace function public.consume_seconds(
  p_user uuid,
  p_kind text,      -- 'conv' | 'call'
  p_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.entitlements%rowtype;
  v_rate integer;             -- segundos por centavo según el tipo
  v_plan_avail integer;
  v_from_plan integer;
  v_remaining integer;
  v_cents_needed integer;
  v_cents_take integer;
  v_from_balance_seconds integer;
  v_shortfall integer;
begin
  if p_kind not in ('conv', 'call') then
    raise exception 'invalid kind: %', p_kind;
  end if;
  if p_seconds is null or p_seconds <= 0 then
    raise exception 'invalid seconds: %', p_seconds;
  end if;

  perform public.ensure_entitlements(p_user);

  select * into v_row
  from public.entitlements
  where user_id = p_user
  for update;

  v_rate := case when p_kind = 'conv' then 6 else 4 end;
  v_plan_avail := case when p_kind = 'conv'
                       then v_row.plan_conv_seconds
                       else v_row.plan_call_seconds end;

  -- 1) Cubeta del plan.
  v_from_plan := least(v_plan_avail, p_seconds);
  v_remaining := p_seconds - v_from_plan;

  -- 2) Saldo: los segundos restantes se cobran en centavos.
  v_cents_needed := 0;
  v_cents_take := 0;
  v_from_balance_seconds := 0;
  if v_remaining > 0 then
    v_cents_needed := ceil(v_remaining::numeric / v_rate)::integer;
    v_cents_take := least(v_row.balance_cents, v_cents_needed);
    if v_cents_take >= v_cents_needed then
      v_from_balance_seconds := v_remaining;  -- el saldo cubre todo lo que faltaba
    else
      v_from_balance_seconds := v_cents_take * v_rate;  -- cada centavo se usa entero
    end if;
  end if;
  v_shortfall := p_seconds - v_from_plan - v_from_balance_seconds;

  -- Aplicar los descuentos.
  if p_kind = 'conv' then
    update public.entitlements
    set plan_conv_seconds = plan_conv_seconds - v_from_plan,
        balance_cents = balance_cents - v_cents_take,
        updated_at = now()
    where user_id = p_user;
  else
    update public.entitlements
    set plan_call_seconds = plan_call_seconds - v_from_plan,
        balance_cents = balance_cents - v_cents_take,
        updated_at = now()
    where user_id = p_user;
  end if;

  -- Anotar los movimientos (solo los que movieron algo).
  if v_from_plan > 0 then
    insert into public.usage_ledger (user_id, kind, seconds_delta, cents_delta, meta)
    values (p_user,
            case when p_kind = 'conv' then 'plan_conv' else 'plan_call' end,
            -v_from_plan, 0,
            jsonb_build_object('requested_seconds', p_seconds));
  end if;
  if v_from_balance_seconds > 0 then
    insert into public.usage_ledger (user_id, kind, seconds_delta, cents_delta, meta)
    values (p_user,
            case when p_kind = 'conv' then 'balance_conv' else 'balance_call' end,
            -v_from_balance_seconds, -v_cents_take,
            jsonb_build_object('requested_seconds', p_seconds,
                               'seconds_per_cent', v_rate));
  end if;

  select * into v_row from public.entitlements where user_id = p_user;

  return jsonb_build_object(
    'from_plan', v_from_plan,
    'from_balance_seconds', v_from_balance_seconds,
    'from_balance_cents', v_cents_take,
    'shortfall', v_shortfall,
    'plan_conv_seconds', v_row.plan_conv_seconds,
    'plan_call_seconds', v_row.plan_call_seconds,
    'balance_cents', v_row.balance_cents
  );
end;
$$;

-- ---------- 6) RPC: acreditar saldo (recarga) ----------
create or replace function public.credit_balance(
  p_user uuid,
  p_cents integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new integer;
begin
  if p_cents is null or p_cents <= 0 then
    raise exception 'invalid cents: %', p_cents;
  end if;

  perform public.ensure_entitlements(p_user);

  update public.entitlements
  set balance_cents = balance_cents + p_cents,
      updated_at = now()
  where user_id = p_user
  returning balance_cents into v_new;

  insert into public.usage_ledger (user_id, kind, seconds_delta, cents_delta, meta)
  values (p_user, 'topup', 0, p_cents, '{}'::jsonb);

  return v_new;
end;
$$;

-- ---------- 7) RPC: aplicar un plan (alta o renovación) ----------
-- Fija el plan y REINICIA las cubetas a su monto completo (los
-- minutos no se acumulan entre ciclos). Guarda el fin del ciclo
-- y los ids de Stripe. El saldo NO se toca.
create or replace function public.apply_plan(
  p_user uuid,
  p_plan text,             -- 'free' | 'basico' | 'plus' | 'premium'
  p_cycle_ends timestamptz,
  p_stripe_customer text,
  p_stripe_sub text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv integer;
  v_call integer;
  v_row public.entitlements%rowtype;
begin
  if p_plan not in ('free', 'basico', 'plus', 'premium') then
    raise exception 'invalid plan: %', p_plan;
  end if;

  -- Montos completos por plan (segundos de conversación / llamada).
  v_conv := case p_plan
              when 'basico' then 3600
              when 'plus' then 7200
              when 'premium' then 10800
              else 0 end;
  v_call := case p_plan
              when 'basico' then 1800
              when 'plus' then 3600
              when 'premium' then 6000
              else 0 end;

  perform public.ensure_entitlements(p_user);

  update public.entitlements
  set plan = p_plan,
      plan_conv_seconds = v_conv,
      plan_call_seconds = v_call,
      cycle_ends_at = p_cycle_ends,
      stripe_customer_id = coalesce(p_stripe_customer, stripe_customer_id),
      stripe_subscription_id = coalesce(p_stripe_sub, stripe_subscription_id),
      updated_at = now()
  where user_id = p_user
  returning * into v_row;

  insert into public.usage_ledger (user_id, kind, seconds_delta, cents_delta, meta)
  values (p_user, 'plan_grant', v_conv + v_call, 0,
          jsonb_build_object('plan', p_plan,
                             'conv_seconds', v_conv,
                             'call_seconds', v_call,
                             'cycle_ends_at', p_cycle_ends));

  return jsonb_build_object(
    'plan', v_row.plan,
    'plan_conv_seconds', v_row.plan_conv_seconds,
    'plan_call_seconds', v_row.plan_call_seconds,
    'balance_cents', v_row.balance_cents,
    'cycle_ends_at', v_row.cycle_ends_at
  );
end;
$$;

-- ---------- 8) Permisos de las funciones ----------
-- Por defecto, las funciones nuevas son ejecutables por PUBLIC:
-- se revoca a todos y se concede SOLO al service role (el
-- servidor). Ni anon ni authenticated pueden llamarlas directo.
revoke execute on function public.ensure_entitlements(uuid) from public, anon, authenticated;
revoke execute on function public.consume_seconds(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.credit_balance(uuid, integer) from public, anon, authenticated;
revoke execute on function public.apply_plan(uuid, text, timestamptz, text, text) from public, anon, authenticated;

grant execute on function public.ensure_entitlements(uuid) to service_role;
grant execute on function public.consume_seconds(uuid, text, integer) to service_role;
grant execute on function public.credit_balance(uuid, integer) to service_role;
grant execute on function public.apply_plan(uuid, text, timestamptz, text, text) to service_role;

-- ============================================================
-- FIN. Orden de uso desde el servidor (api/usage.js + webhooks
-- de Stripe en la Fase 3): status = leer entitlements;
-- consume = rpc consume_seconds; recarga = rpc credit_balance
-- (tras pago confirmado); plan = rpc apply_plan.
-- ============================================================


-- ---------- Bienvenida pa' usuarios que YA existían ----------
-- Quien se registró antes de este SQL no pasa por el trigger nuevo:
-- se le acredita la misma bienvenida (600 s de conversación) una
-- sola vez (si ya tiene un renglón 'welcome', no se repite).
with nuevos as (
  insert into public.usage_ledger (user_id, kind, seconds_delta)
  select e.user_id, 'welcome', 600
  from public.entitlements e
  where not exists (
    select 1 from public.usage_ledger l
    where l.user_id = e.user_id and l.kind = 'welcome'
  )
  returning user_id
)
update public.entitlements e
set plan_conv_seconds = e.plan_conv_seconds + 600,
    updated_at = now()
where e.user_id in (select user_id from nuevos);
