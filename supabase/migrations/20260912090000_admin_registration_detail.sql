-- Extend the admin registrations list with program status/id, and add a
-- per-registration detail RPC (profile + weight history + scheduled emails)
-- so the admin screen can show an individual participant's full record.

drop function if exists public.get_diet_registrations(text);

create function public.get_diet_registrations(admin_password text)
returns table (
  id bigint,
  email text,
  weight numeric,
  target_weight numeric,
  plan text,
  summary text,
  tags text,
  registered_at timestamptz,
  program_status text,
  started_at timestamptz,
  ended_at timestamptz,
  test_mode boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if encode(sha256(convert_to(admin_password, 'UTF8')), 'hex')
    <> '6ef6a24b912e39664050636e1c323b9dcc579ff82c656a424bc83151c49964e7' then
    raise exception using
      errcode = '28000',
      message = 'Invalid admin password';
  end if;

  return query
    select
      r.id,
      r.email,
      r.weight,
      r.target_weight,
      r.plan,
      r.summary,
      r.tags,
      r.registered_at,
      r.program_status,
      r.started_at,
      r.ended_at,
      r.test_mode
    from public.registrations as r
    order by r.registered_at desc
    limit 200;
end;
$$;

revoke all on function public.get_diet_registrations(text) from public;
grant execute on function public.get_diet_registrations(text) to anon, authenticated;

create or replace function public.get_diet_registration_detail(
  admin_password text,
  target_id bigint
)
returns table (
  id bigint,
  email text,
  weight numeric,
  target_weight numeric,
  plan text,
  summary text,
  tags text,
  registered_at timestamptz,
  program_status text,
  started_at timestamptz,
  ended_at timestamptz,
  test_mode boolean,
  weight_history jsonb,
  scheduled_emails jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if encode(sha256(convert_to(admin_password, 'UTF8')), 'hex')
    <> '6ef6a24b912e39664050636e1c323b9dcc579ff82c656a424bc83151c49964e7' then
    raise exception using
      errcode = '28000',
      message = 'Invalid admin password';
  end if;

  return query
    select
      r.id,
      r.email,
      r.weight,
      r.target_weight,
      r.plan,
      r.summary,
      r.tags,
      r.registered_at,
      r.program_status,
      r.started_at,
      r.ended_at,
      r.test_mode,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'weight', w.weight,
          'recorded_at', w.recorded_at,
          'checkin_type', w.checkin_type,
          'feedback_sent_at', w.feedback_sent_at
        ) order by w.recorded_at asc, w.id asc)
        from public.weight_entries as w
        where w.registration_id = r.id
      ), '[]'::jsonb),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'milestone', s.milestone,
          'scheduled_for', s.scheduled_for,
          'status', s.status
        ) order by s.scheduled_for asc)
        from public.scheduled_program_emails as s
        where s.registration_id = r.id
      ), '[]'::jsonb)
    from public.registrations as r
    where r.id = target_id;
end;
$$;

revoke all on function public.get_diet_registration_detail(text, bigint) from public;
grant execute on function public.get_diet_registration_detail(text, bigint) to anon, authenticated;
