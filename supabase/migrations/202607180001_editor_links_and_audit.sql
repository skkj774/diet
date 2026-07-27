create extension if not exists pgcrypto with schema extensions;
create table if not exists public.editor_admin_config (
  id smallint primary key default 1 check (id = 1),
  key_hash bytea not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.editor_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  token_hash bytea not null unique,
  share_memo text not null default '',
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create table if not exists public.editor_audit_logs (
  id bigint generated always as identity primary key,
  editor_account_id uuid references public.editor_accounts(id) on delete set null,
  actor_name text not null,
  action text not null,
  agency_name text,
  talent_name text,
  from_value text,
  to_value text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists editor_audit_logs_created_at_idx
  on public.editor_audit_logs (created_at desc);
alter table public.editor_admin_config enable row level security;
alter table public.editor_accounts enable row level security;
alter table public.editor_audit_logs enable row level security;
revoke all on public.editor_admin_config from anon, authenticated;
revoke all on public.editor_accounts from anon, authenticated;
revoke all on public.editor_audit_logs from anon, authenticated;
-- 既存の管理キーをDB側のハッシュに移行する。管理画面から新しい編集リンクを発行する。
insert into public.editor_admin_config (id, key_hash)
values (1, decode('e00c1036785cd42fd6504a622df83b4907e09a13218b0411e083bc364ffc1c9d', 'hex'))
on conflict (id) do nothing;
create or replace function public.editor_context(p_token text, p_admin_key text)
returns table(account_id uuid, display_name text, is_manager boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.editor_accounts%rowtype;
begin
  if p_admin_key is not null and exists (
    select 1 from public.editor_admin_config
    where id = 1 and key_hash = extensions.digest(p_admin_key, 'sha256')
  ) then
    return query select null::uuid, '管理者'::text, true;
    return;
  end if;

  if p_token is null then raise exception 'invalid editor link'; end if;
  select * into v_account
  from public.editor_accounts
  where token_hash = extensions.digest(p_token, 'sha256')
    and is_active
    and (expires_at is null or expires_at > now());
  if not found then raise exception 'invalid or expired editor link'; end if;

  update public.editor_accounts set last_used_at = now() where id = v_account.id;
  return query select v_account.id, v_account.display_name, false;
end;
$$;
create or replace function public.create_editor_link(
  p_admin_key text, p_display_name text, p_share_memo text, p_expires_at timestamptz
)
returns table(id uuid, token text, display_name text, share_memo text, expires_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return query
    insert into public.editor_accounts(display_name, token_hash, share_memo, expires_at)
    values (trim(p_display_name), extensions.digest(v_token, 'sha256'), coalesce(p_share_memo, ''), p_expires_at)
    returning editor_accounts.id, v_token, editor_accounts.display_name,
      editor_accounts.share_memo, editor_accounts.expires_at, editor_accounts.created_at;
end;
$$;
create or replace function public.list_editor_accounts(p_admin_key text)
returns table(id uuid, display_name text, share_memo text, is_active boolean,
  expires_at timestamptz, created_at timestamptz, last_used_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return query select a.id, a.display_name, a.share_memo, a.is_active,
    a.expires_at, a.created_at, a.last_used_at
  from public.editor_accounts a order by a.created_at desc;
end;
$$;
create or replace function public.set_editor_account_active(p_admin_key text, p_id uuid, p_is_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  update public.editor_accounts set is_active = p_is_active where id = p_id;
end;
$$;
create or replace function public.list_editor_audit_logs(p_admin_key text, p_limit integer)
returns table(id bigint, actor_name text, action text, agency_name text, talent_name text,
  from_value text, to_value text, details jsonb, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return query select l.id, l.actor_name, l.action, l.agency_name, l.talent_name,
    l.from_value, l.to_value, l.details, l.created_at
  from public.editor_audit_logs l order by l.created_at desc limit least(greatest(p_limit, 1), 10000);
end;
$$;
create or replace function public.editor_add_talent(
  p_token text, p_admin_key text, p_agency_id text, p_category_name text, p_name text, p_sort_order integer
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor record; v_cat_id bigint; v_agency text; v_log_id bigint;
begin
  select * into v_actor from public.editor_context(p_token, p_admin_key);
  select name into v_agency from public.agencies where id::text = p_agency_id;
  if v_agency is null then raise exception 'agency not found'; end if;
  select id into v_cat_id from public.talent_categories
    where agency_id::text = p_agency_id and name = p_category_name limit 1;
  if v_cat_id is null then
    insert into public.talent_categories(agency_id, name, sort_order)
    select id, p_category_name, coalesce((select max(sort_order)+1 from public.talent_categories where agency_id::text=p_agency_id),0)
    from public.agencies where id::text=p_agency_id returning id into v_cat_id;
  end if;
  insert into public.agency_talents(category_id, name, sort_order) values(v_cat_id, p_name, p_sort_order);
  insert into public.editor_audit_logs(editor_account_id, actor_name, action, agency_name, talent_name, to_value)
    values(v_actor.account_id, v_actor.display_name, '追加', v_agency, p_name, p_category_name) returning id into v_log_id;
  update public.site_meta set updated_at=now() where id=1;
  return v_log_id;
end;
$$;
create or replace function public.editor_delete_talent(
  p_token text, p_admin_key text, p_agency_id text, p_category_name text, p_name text
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor record; v_cat_id bigint; v_agency text; v_log_id bigint;
begin
  select * into v_actor from public.editor_context(p_token, p_admin_key);
  select name into v_agency from public.agencies where id::text=p_agency_id;
  select id into v_cat_id from public.talent_categories where agency_id::text=p_agency_id and name=p_category_name limit 1;
  if v_cat_id is null then raise exception 'category not found'; end if;
  delete from public.agency_talents where category_id=v_cat_id and name=p_name;
  if not found then raise exception 'talent not found'; end if;
  if not exists(select 1 from public.agency_talents where category_id=v_cat_id) then
    delete from public.talent_categories where id=v_cat_id;
  end if;
  insert into public.editor_audit_logs(editor_account_id, actor_name, action, agency_name, talent_name, from_value)
    values(v_actor.account_id, v_actor.display_name, '削除', v_agency, p_name, p_category_name) returning id into v_log_id;
  update public.site_meta set updated_at=now() where id=1;
  return v_log_id;
end;
$$;
create or replace function public.editor_move_talent(
  p_token text, p_admin_key text, p_agency_id text, p_from_category text, p_to_category text, p_name text, p_sort_order integer
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor record; v_from_id bigint; v_to_id bigint; v_agency text; v_log_id bigint;
begin
  select * into v_actor from public.editor_context(p_token, p_admin_key);
  select name into v_agency from public.agencies where id::text=p_agency_id;
  select id into v_from_id from public.talent_categories where agency_id::text=p_agency_id and name=p_from_category limit 1;
  select id into v_to_id from public.talent_categories where agency_id::text=p_agency_id and name=p_to_category limit 1;
  if v_from_id is null then raise exception 'source category not found'; end if;
  if v_to_id is null then
    insert into public.talent_categories(agency_id,name,sort_order)
    select id,p_to_category,coalesce((select max(sort_order)+1 from public.talent_categories where agency_id::text=p_agency_id),0)
    from public.agencies where id::text=p_agency_id returning id into v_to_id;
  end if;
  delete from public.agency_talents where category_id=v_from_id and name=p_name;
  if not found then raise exception 'talent not found'; end if;
  insert into public.agency_talents(category_id,name,sort_order) values(v_to_id,p_name,p_sort_order);
  if not exists(select 1 from public.agency_talents where category_id=v_from_id) then
    delete from public.talent_categories where id=v_from_id;
  end if;
  insert into public.editor_audit_logs(editor_account_id,actor_name,action,agency_name,talent_name,from_value,to_value)
    values(v_actor.account_id,v_actor.display_name,'移動',v_agency,p_name,p_from_category,p_to_category) returning id into v_log_id;
  update public.site_meta set updated_at=now() where id=1;
  return v_log_id;
end;
$$;
create or replace function public.editor_update_talent(
  p_token text, p_admin_key text, p_agency_id text, p_from_category text, p_to_category text,
  p_old_name text, p_new_name text, p_sort_order integer, p_x_url text, p_ig_url text
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor record; v_from_id bigint; v_to_id bigint; v_agency text; v_log_id bigint;
begin
  select * into v_actor from public.editor_context(p_token,p_admin_key);
  select name into v_agency from public.agencies where id::text=p_agency_id;
  select id into v_from_id from public.talent_categories where agency_id::text=p_agency_id and name=p_from_category limit 1;
  select id into v_to_id from public.talent_categories where agency_id::text=p_agency_id and name=p_to_category limit 1;
  if v_from_id is null then raise exception 'source category not found'; end if;
  if v_to_id is null then
    insert into public.talent_categories(agency_id,name,sort_order)
    select id,p_to_category,coalesce((select max(sort_order)+1 from public.talent_categories where agency_id::text=p_agency_id),0)
    from public.agencies where id::text=p_agency_id returning id into v_to_id;
  end if;
  delete from public.agency_talents where category_id=v_from_id and name=p_old_name;
  if not found then raise exception 'talent not found'; end if;
  insert into public.agency_talents(category_id,name,sort_order) values(v_to_id,p_new_name,p_sort_order);
  if v_from_id <> v_to_id and not exists(select 1 from public.agency_talents where category_id=v_from_id) then
    delete from public.talent_categories where id=v_from_id;
  end if;
  if p_old_name <> p_new_name then delete from public.sns_links where name=p_old_name; end if;
  insert into public.sns_links(name,x_url,ig_url) values(p_new_name,nullif(p_x_url,''),nullif(p_ig_url,''))
    on conflict(name) do update set x_url=excluded.x_url,ig_url=excluded.ig_url;
  insert into public.editor_audit_logs(editor_account_id,actor_name,action,agency_name,talent_name,from_value,to_value,details)
    values(v_actor.account_id,v_actor.display_name,'編集',v_agency,p_new_name,
      p_from_category||' / '||p_old_name,p_to_category||' / '||p_new_name,
      jsonb_build_object('x_url',nullif(p_x_url,''),'ig_url',nullif(p_ig_url,''))) returning id into v_log_id;
  update public.site_meta set updated_at=now() where id=1;
  return v_log_id;
end;
$$;
grant execute on function public.editor_context(text,text) to anon, authenticated;
grant execute on function public.create_editor_link(text,text,text,timestamptz) to anon, authenticated;
grant execute on function public.list_editor_accounts(text) to anon, authenticated;
grant execute on function public.set_editor_account_active(text,uuid,boolean) to anon, authenticated;
grant execute on function public.list_editor_audit_logs(text,integer) to anon, authenticated;
grant execute on function public.editor_add_talent(text,text,text,text,text,integer) to anon, authenticated;
grant execute on function public.editor_delete_talent(text,text,text,text,text) to anon, authenticated;
grant execute on function public.editor_move_talent(text,text,text,text,text,text,integer) to anon, authenticated;
grant execute on function public.editor_update_talent(text,text,text,text,text,text,text,integer,text,text) to anon, authenticated;
-- 書き込みは必ず上記RPCを通し、本人確認とログ記録を同一トランザクションで行う。
revoke insert, update, delete on public.talent_categories from anon, authenticated;
revoke insert, update, delete on public.agency_talents from anon, authenticated;
revoke insert, update, delete on public.sns_links from anon, authenticated;
revoke insert, update, delete on public.site_meta from anon, authenticated;
