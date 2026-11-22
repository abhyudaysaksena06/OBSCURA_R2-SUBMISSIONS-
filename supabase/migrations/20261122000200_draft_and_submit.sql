-- Each bug is its own report: a team saves drafts, removes drafts it no longer wants,
-- and submits each bug on its own. A submitted bug is final and gets its own timestamp.

alter table public.reports
  add column status text not null default 'draft' check (status in ('draft', 'submitted')),
  add column submitted_at timestamptz,
  add constraint reports_submitted_at_chk check ((status = 'submitted') = (submitted_at is not null));
create index reports_submitted_at_idx on public.reports (submitted_at);

-- Teams: see all their own; organisers: see submitted only.
drop policy reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated
  using (team_id = (select auth.uid()) or (status = 'submitted' and (select public.is_organiser())));

-- Only drafts can be edited or removed.
drop policy reports_update on public.reports;
create policy reports_update on public.reports for update to authenticated
  using (team_id = (select auth.uid()) and status = 'draft' and (select public.submissions_open()))
  with check (team_id = (select auth.uid()) and status = 'draft' and (select public.submissions_open()));

drop policy reports_delete on public.reports;
create policy reports_delete on public.reports for delete to authenticated
  using (team_id = (select auth.uid()) and status = 'draft' and (select public.submissions_open()));

-- Submitting goes through this function so the timestamp comes from the server.
create or replace function public.submit_report(p_id bigint)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if not public.submissions_open() then
    raise exception 'Submissions are closed.';
  end if;
  update public.reports
     set status = 'submitted', submitted_at = clock_timestamp()
   where id = p_id and team_id = (select auth.uid()) and status = 'draft'
  returning submitted_at into v_at;
  if v_at is null then
    raise exception 'Report not found or already submitted.';
  end if;
  return v_at;
end;
$$;
revoke execute on function public.submit_report(bigint) from public, anon;
grant execute on function public.submit_report(bigint) to authenticated;
