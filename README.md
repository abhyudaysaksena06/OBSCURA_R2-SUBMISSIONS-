# OBSCURA Round 2: bug submission portal

A small web portal where each team signs in and reports the bugs it found and how it fixed them.
Teams write free-form reports. The portal holds no bug list and shows no count or progress.

- **Frontend:** Vite + plain JavaScript, deployed on Vercel.
- **Backend:** Supabase (Postgres, Auth, Row Level Security).

## What teams see (`/`)

- Sign in with the username and password the organisers give them.
- A form to add **one bug at a time**: short title, what they saw, where in the game, how to make it happen,
  how they fixed it, files and lines changed, and the code change or diff.
- Each bug is saved as a **draft** (editable, removable) and **submitted on its own**. Submitting is final and
  records a server timestamp (`submitted_at`) used for tie-breaks.
- Lists of their own drafts and submitted bugs.
- They never see other teams' reports, verdicts, points or notes.

## What organisers see (`/organiser`)

- Open or close submissions, and post a notice to every team.
- A table per team: reports, valid, invalid, duplicate, pending, points and last submission time.
- Every submitted bug with its submit time (drafts are never shown), filters by team and verdict, and text search.
- Mark each report valid, invalid or duplicate with optional points and a private note.
- Export everything as CSV.

## Security model

All rules live in the database (`supabase/migrations/`), so they hold even if someone calls the API directly.

| Who | reports | report_reviews (verdicts) | teams | settings |
| --- | --- | --- | --- | --- |
| Signed-out | none | none | none | none |
| Team | read own; create, edit and remove own **drafts**; submit via `submit_report()`; only while open | none | own row | read |
| Organiser | read all **submitted**, cannot edit | read/write | read all | read/update |

Teams can only set the text fields; `team_id`, timestamps and ids are set by the database.
A signed-in account that is not in `teams` cannot submit. Each team is capped at 300 reports to stop flooding.

## Setup

### 1. Supabase

1. Create a project at <https://supabase.com> (the free plan is enough).
2. Run the files in `supabase/migrations/` in order in **SQL Editor** (or `supabase db push` with the CLI).
3. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up".
   (Unknown accounts already cannot submit, but this keeps strangers out entirely.)
4. **Project Settings → API:** copy the Project URL, the publishable/anon key and the service-role/secret key.

### 2. Load team logins

Teams type only a username. The portal turns it into `username@LOGIN_DOMAIN` behind the scenes; no email is ever sent.

```bash
cp .env.example .env        # fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm install
cp teams.example.csv teams.csv   # one row per team, plus a row with role=organiser for each judge
npm run import-teams -- teams.csv --dry-run   # check
npm run import-teams -- teams.csv             # create / update logins
```

Or, without Node, in the SQL Editor:

```sql
select private.upsert_login('team01', 'their-password', 'Team One', 'team');
select private.upsert_login('judge', 'their-password', 'Organiser', 'organiser');
```

CSV columns: `username,password,team_name,role` where `role` is `team` (default) or `organiser`.
Re-running the import is safe: existing accounts get the new password and team name.
`teams.csv` and `.env` are git-ignored. **Never commit them, and never put the service-role key in Vercel.**

### 3. Hosting

`.env.production` holds the public browser config for the OBSCURA Supabase project, so builds need no extra settings.

**GitHub Pages:** repo **Settings → Pages → Source: GitHub Actions**. `.github/workflows/pages.yml` then deploys on every push.

**Vercel:**

1. Import this repository in Vercel (framework preset: Vite; `vercel.json` sets the build).
2. Optional, to point at a different Supabase project, override these environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` (the publishable/anon key, which is safe in the browser)
   - `VITE_LOGIN_DOMAIN` (optional, default `teams.obscura.local`; must match `LOGIN_DOMAIN` used for the import)
3. Deploy. Teams use `/`, organisers use `/organiser`.

### Local development

```bash
cp .env.example .env   # fill in the VITE_ values
npm install
npm run dev
```

## On the day

- Close submissions at the deadline from `/organiser`; teams can still read their reports but cannot change them.
- Export the CSV as a backup once judging is done.

## Tests

`supabase/tests/rls-check.sql` exercises the access rules against a plain Postgres with
`supabase/tests/local-auth-stub.sql` standing in for Supabase Auth:

```bash
psql -v ON_ERROR_STOP=1 -f supabase/tests/local-auth-stub.sql -f supabase/migrations/20261122000000_init.sql
psql -f supabase/tests/rls-check.sql
```
