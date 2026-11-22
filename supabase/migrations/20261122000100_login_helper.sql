-- Triggers run without EXECUTE; nobody needs to call this one over the API.
revoke execute on function public.reports_limit() from anon, authenticated, public;

-- Organiser helper to create or update a login straight from the SQL Editor:
--   select private.upsert_login('team01', 'their-password', 'Team One', 'team');
--   select private.upsert_login('judge', 'their-password', 'Organiser', 'organiser');
-- Lives in a schema the API does not expose, and only the database owner can run it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.upsert_login(
  p_username text, p_password text, p_team_name text default null,
  p_role text default 'team', p_domain text default 'teams.obscura.local'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_username text := lower(trim(p_username));
  v_email text := v_username || '@' || p_domain;
  v_id uuid;
begin
  if v_username !~ '^[a-z0-9][a-z0-9._-]{1,62}$' then raise exception 'bad username %', p_username; end if;
  if char_length(p_password) < 6 then raise exception 'password too short for %', p_username; end if;
  if p_role not in ('team', 'organiser') then raise exception 'role must be team or organiser'; end if;

  select id into v_id from auth.users where email = v_email;
  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('username', v_username, 'team_name', coalesce(p_team_name, v_username)),
      now(), now(), '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (v_id::text, v_id,
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now());
  else
    update auth.users
       set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_user_meta_data = jsonb_build_object('username', v_username, 'team_name', coalesce(p_team_name, v_username)),
           updated_at = now()
     where id = v_id;
  end if;

  if p_role = 'organiser' then
    insert into public.organisers (user_id, username) values (v_id, v_username)
      on conflict (user_id) do update set username = excluded.username;
    delete from public.teams where user_id = v_id;
  else
    insert into public.teams (user_id, username, team_name) values (v_id, v_username, coalesce(p_team_name, v_username))
      on conflict (user_id) do update set username = excluded.username, team_name = excluded.team_name;
    delete from public.organisers where user_id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function private.upsert_login(text, text, text, text, text) from public, anon, authenticated;
