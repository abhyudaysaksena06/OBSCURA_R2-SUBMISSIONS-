-- OBSCURA Round 2 bug submission portal
-- Teams log in, submit free-form bug reports and edit only their own.
-- Organisers see every report and record a verdict that teams never see.

-- ---------------------------------------------------------------- tables

create table public.teams (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  team_name  text not null,
  created_at timestamptz not null default now()
);

create table public.organisers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  created_at timestamptz not null default now()
);

-- Single-row settings table (id is always true).
create table public.settings (
  id               boolean primary key default true check (id),
  submissions_open boolean not null default true,
  notice           text check (char_length(notice) <= 500),
  updated_at       timestamptz not null default now()
);
insert into public.settings (id) values (true);

create table public.reports (
  id         bigint generated always as identity primary key,
  team_id    uuid not null default auth.uid() references public.teams (user_id) on delete cascade,
  title      text not null check (char_length(title) between 3 and 200),
  observed   text not null check (char_length(observed) between 10 and 5000),
  location   text check (char_length(location) <= 500),
  steps      text check (char_length(steps) <= 3000),
  fix        text not null check (char_length(fix) between 10 and 8000),
  code_ref   text check (char_length(code_ref) <= 500),
  diff       text check (char_length(diff) <= 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_team_id_idx on public.reports (team_id);
create index reports_created_at_idx on public.reports (created_at);

-- Organiser-only verdicts. Kept in their own table so teams can never read them.
create table public.report_reviews (
  report_id   bigint primary key references public.reports (id) on delete cascade,
  verdict     text not null check (verdict in ('valid', 'invalid', 'duplicate')),
  points      integer check (points between -100 and 100),
  note        text check (char_length(note) <= 2000),
  reviewed_by uuid references auth.users (id) on delete set null default auth.uid(),
  reviewed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers

create or replace function public.is_organiser()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.organisers o where o.user_id = (select auth.uid()));
$$;

create or replace function public.is_team()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.teams t where t.user_id = (select auth.uid()));
$$;

create or replace function public.submissions_open()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select s.submissions_open from public.settings s where s.id), false);
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reports_touch before update on public.reports
  for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- Abuse guard: a generous per-team ceiling so a script cannot flood the table.
create or replace function public.reports_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.reports r where r.team_id = new.team_id) >= 300 then
    raise exception 'Report limit reached for this team. Contact the organisers.';
  end if;
  return new;
end;
$$;

create trigger reports_limit before insert on public.reports
  for each row execute function public.reports_limit();

-- ---------------------------------------------------------------- privileges

revoke all on public.teams, public.organisers, public.settings,
              public.reports, public.report_reviews from anon;

revoke insert, update on public.reports from authenticated;
grant select, delete on public.reports to authenticated;
grant insert (title, observed, location, steps, fix, code_ref, diff) on public.reports to authenticated;
grant update (title, observed, location, steps, fix, code_ref, diff) on public.reports to authenticated;

revoke insert, update, delete on public.teams, public.organisers from authenticated;
grant select on public.teams, public.organisers to authenticated;

revoke insert, delete on public.settings from authenticated;
grant select on public.settings to authenticated;
revoke update on public.settings from authenticated;
grant update (submissions_open, notice) on public.settings to authenticated;

grant select, insert, update, delete on public.report_reviews to authenticated;

revoke execute on function public.is_organiser(), public.is_team(), public.submissions_open() from anon, public;
grant execute on function public.is_organiser(), public.is_team(), public.submissions_open() to authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.teams          enable row level security;
alter table public.organisers     enable row level security;
alter table public.settings       enable row level security;
alter table public.reports        enable row level security;
alter table public.report_reviews enable row level security;

-- teams: a team sees its own row, organisers see all
create policy teams_select on public.teams for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_organiser()));

-- organisers: an organiser sees the organiser list
create policy organisers_select on public.organisers for select to authenticated
  using ((select public.is_organiser()));

-- settings: everyone signed in reads, organisers change
create policy settings_select on public.settings for select to authenticated using (true);
create policy settings_update on public.settings for update to authenticated
  using ((select public.is_organiser())) with check ((select public.is_organiser()));

-- reports: a team reads/writes only its own, and only while submissions are open
create policy reports_select on public.reports for select to authenticated
  using (team_id = (select auth.uid()) or (select public.is_organiser()));

create policy reports_insert on public.reports for insert to authenticated
  with check (
    team_id = (select auth.uid())
    and (select public.is_team())
    and (select public.submissions_open())
  );

create policy reports_update on public.reports for update to authenticated
  using (team_id = (select auth.uid()) and (select public.submissions_open()))
  with check (team_id = (select auth.uid()) and (select public.submissions_open()));

create policy reports_delete on public.reports for delete to authenticated
  using (team_id = (select auth.uid()) and (select public.submissions_open()));

-- report_reviews: organisers only
create policy reviews_all on public.report_reviews for all to authenticated
  using ((select public.is_organiser())) with check ((select public.is_organiser()));
