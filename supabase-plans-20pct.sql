-- ============================================================
-- Englix · Planes — regla del 20% (2026-10-23)
-- Aplicar en el SQL Editor DESPUÉS de supabase-billing.sql —
-- actualiza los minutos de los planes a la regla del 20%.
--
-- Regla decidida por Noel: la ganancia limpia es el 20% del
-- precio del plan calculado en el PEOR caso (el usuario gasta
-- TODO). Montos nuevos:
--   · basico  $9.99  = 6600 s conv + 3300 s llamada  (110 + 55 min)
--   · plus    $19.99 = 13200 s conv + 6600 s llamada (220 + 110 min)
--   · premium $29.99 = 19200 s conv + 10800 s llamada (320 + 180 min)
--
-- Solo reemplaza la función apply_plan (idéntica a la de
-- supabase-billing.sql, con los montos nuevos) y reafirma sus
-- permisos. No toca tablas ni datos: los planes ya otorgados
-- conservan sus cubetas hasta la próxima renovación, que ya
-- entra con los montos nuevos.
-- ============================================================

-- ---------- RPC: aplicar un plan (alta o renovación) ----------
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
              when 'basico' then 6600
              when 'plus' then 13200
              when 'premium' then 19200
              else 0 end;
  v_call := case p_plan
              when 'basico' then 3300
              when 'plus' then 6600
              when 'premium' then 10800
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

-- ---------- Permisos de apply_plan ----------
-- Ejecutable SOLO por el service role (el servidor).
revoke execute on function public.apply_plan(uuid, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.apply_plan(uuid, text, timestamptz, text, text) to service_role;
