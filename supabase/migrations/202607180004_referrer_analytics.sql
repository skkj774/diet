alter table public.analytics_events
  add column if not exists referrer_category text;
create index if not exists analytics_events_referrer_idx
  on public.analytics_events(event_type,referrer_category);
revoke execute on function public.track_analytics_event(text,text,text,text) from anon, authenticated;
drop function public.track_analytics_event(text,text,text,text);
create function public.track_analytics_event(
  p_event_type text, p_page_key text, p_event_label text, p_session_id text, p_referrer_category text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed_referrers constant text[] := array[
    '直接・不明','サイト内','X（Twitter）','Instagram','Facebook・Messenger','LINE',
    'YouTube','TikTok','Discord','Slack','Microsoft Teams','WhatsApp',
    'Google検索','Yahoo!検索','Bing検索','その他'
  ];
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
  if p_event_type='page_view' and (p_referrer_category is null or not (p_referrer_category = any(v_allowed_referrers))) then
    p_referrer_category := 'その他';
  end if;
  insert into public.analytics_events(event_type, page_key, event_label, session_hash, referrer_category)
  values (
    p_event_type,
    left(trim(p_page_key), 80),
    nullif(left(trim(p_event_label), 160), ''),
    case when p_session_id is null then null else extensions.digest(p_session_id, 'sha256') end,
    case when p_event_type='page_view' then p_referrer_category else null end
  );
end;
$$;
create function public.get_referrer_analytics(p_admin_key text, p_days integer)
returns table(source text, visits bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare v_days integer := least(greatest(coalesce(p_days,30),1),365);
begin
  perform 1 from public.editor_context(null,p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return query
    select coalesce(e.referrer_category,'記録開始前') as source, count(*) as visits
    from public.analytics_events e
    where e.event_type='page_view' and e.created_at >= now()-make_interval(days=>v_days)
    group by coalesce(e.referrer_category,'記録開始前')
    order by count(*) desc, coalesce(e.referrer_category,'記録開始前');
end;
$$;
grant execute on function public.track_analytics_event(text,text,text,text,text) to anon, authenticated;
grant execute on function public.get_referrer_analytics(text,integer) to anon, authenticated;
