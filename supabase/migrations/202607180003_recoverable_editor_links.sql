alter table public.editor_accounts
  add column if not exists token_ciphertext bytea;
-- リンク本体は管理キーで暗号化して保存し、管理RPC以外からは参照できない。
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
    insert into public.editor_accounts(display_name, token_hash, token_ciphertext, share_memo, expires_at)
    values (
      trim(p_display_name),
      extensions.digest(v_token, 'sha256'),
      extensions.pgp_sym_encrypt(v_token, p_admin_key, 'cipher-algo=aes256'),
      coalesce(p_share_memo, ''),
      p_expires_at
    )
    returning editor_accounts.id, v_token, editor_accounts.display_name,
      editor_accounts.share_memo, editor_accounts.expires_at, editor_accounts.created_at;
end;
$$;
drop function public.list_editor_accounts(text);
create function public.list_editor_accounts(p_admin_key text)
returns table(id uuid, display_name text, share_memo text, is_active boolean,
  expires_at timestamptz, created_at timestamptz, last_used_at timestamptz, token text)
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  return query select a.id, a.display_name, a.share_memo, a.is_active,
    a.expires_at, a.created_at, a.last_used_at,
    case when a.token_ciphertext is null then null
      else extensions.pgp_sym_decrypt(a.token_ciphertext, p_admin_key) end
  from public.editor_accounts a order by a.created_at desc;
end;
$$;
create function public.reissue_editor_link(p_admin_key text, p_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform 1 from public.editor_context(null, p_admin_key) where is_manager;
  if not found then raise exception 'manager access required'; end if;
  update public.editor_accounts
  set token_hash=extensions.digest(v_token, 'sha256'),
      token_ciphertext=extensions.pgp_sym_encrypt(v_token, p_admin_key, 'cipher-algo=aes256'),
      is_active=true,
      last_used_at=null
  where id=p_id;
  if not found then raise exception 'editor account not found'; end if;
  return v_token;
end;
$$;
grant execute on function public.list_editor_accounts(text) to anon, authenticated;
grant execute on function public.reissue_editor_link(text,uuid) to anon, authenticated;
