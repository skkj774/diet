create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('page_view', 'talent_click', 'search')),
  page_key text not null check (length(page_key) between 1 and 80),
  event_label text,
  session_hash bytea,
  created_at timestamptz not null default now()
);
create index if not exists analytics_events_created_at_idx on public.analytics_events(created_at desc);
create index if not exists analytics_events_type_label_idx on public.analytics_events(event_type, event_label);
alter table public.analytics_events enable row level security;
revoke all on public.analytics_events from anon, authenticated;
create or replace function public.track_analytics_event(
  p_event_type text, p_page_key text, p_event_label text, p_session_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_type not in ('page_view', 'talent_click', 'search') then
    raise exception 'invalid analytics event';
  end if;
  if length(trim(coalesce(p_page_key, ''))) not between 1 and 80 then
    raise exception 'invalid page key';
  end if;
  if p_event_type <> 'page_view' and length(trim(coalesce(p_event_label, ''))) not between 1 and 160 then
    raise exception 'event label required';
  end if;
  insert into public.analytics_events(event_type, page_key, event_label, session_hash)
  values (
    p_event_type,
    left(trim(p_page_key), 80),
    nullif(left(trim(p_event_label), 160), ''),
    case when p_session_id is null then null else extensions.digest(p_session_id, 'sha256') end
  );
end;
$$;
create or replace function public.get_analytics_dashboard(p_admin_key text, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return jsonb_build_object(
    'page_totals', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.views desc) from (
        select page_key, count(*)::integer as views
        from public.analytics_events
        where event_type='page_view' and created_at >= now() - make_interval(days => v_days)
        group by page_key
      ) x
    ), '[]'::jsonb),
    'daily_pages', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.day, x.page_key) from (
        select (created_at at time zone 'Asia/Tokyo')::date as day, page_key, count(*)::integer as views
        from public.analytics_events
        where event_type='page_view' and created_at >= now() - make_interval(days => v_days)
        group by 1, page_key
      ) x
    ), '[]'::jsonb),
    'talent_ranking', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.clicks desc, x.talent_name) from (
        select event_label as talent_name, count(*)::integer as clicks
        from public.analytics_events
        where event_type='talent_click' and created_at >= now() - make_interval(days => v_days)
        group by event_label order by clicks desc limit 100
      ) x
    ), '[]'::jsonb),
    'search_ranking', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.searches desc, x.search_term) from (
        select lower(event_label) as search_term, count(*)::integer as searches
        from public.analytics_events
        where event_type='search' and created_at >= now() - make_interval(days => v_days)
        group by lower(event_label) order by searches desc limit 100
      ) x
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.editor_delete_talent(text,text,text,text,text) from anon, authenticated;
drop function public.editor_delete_talent(text,text,text,text,text);
create function public.editor_delete_talent(
  p_token text, p_admin_key text, p_agency_id text, p_category_name text, p_name text, p_delete_reason text
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor record; v_cat_id bigint; v_agency text; v_log_id bigint;
begin
  if p_delete_reason not in ('所属事務所が変わった','解散した','名前が変わった','芸人をやめた','その他') then
    raise exception '削除理由を選択してください';
  end if;
  select * into v_actor from public.editor_context(p_token, p_admin_key);
  select name into v_agency from public.agencies where id::text=p_agency_id;
  select id into v_cat_id from public.talent_categories where agency_id::text=p_agency_id and name=p_category_name limit 1;
  if v_cat_id is null then raise exception 'category not found'; end if;
  delete from public.agency_talents where category_id=v_cat_id and name=p_name;
  if not found then raise exception 'talent not found'; end if;
  if not exists(select 1 from public.agency_talents where category_id=v_cat_id) then
    delete from public.talent_categories where id=v_cat_id;
  end if;
  insert into public.editor_audit_logs(editor_account_id, actor_name, action, agency_name, talent_name, from_value, details)
    values(v_actor.account_id, v_actor.display_name, '削除', v_agency, p_name, p_category_name,
      jsonb_build_object('delete_reason', p_delete_reason)) returning id into v_log_id;
  update public.site_meta set updated_at=now() where id=1;
  return v_log_id;
end;
$$;
grant execute on function public.track_analytics_event(text,text,text,text) to anon, authenticated;
grant execute on function public.get_analytics_dashboard(text,integer) to anon, authenticated;
grant execute on function public.editor_delete_talent(text,text,text,text,text,text) to anon, authenticated;
