import './style.css';
import { supabase, configured, usernameToEmail, esc, fmtTime, friendlyError, notConfiguredHtml } from './supabase.js';

const app = document.getElementById('app');
const who = document.getElementById('who');
const toastEl = document.getElementById('toast');

let state = { user: null, settings: null, teams: [], reports: [], filter: { team: '', verdict: '', q: '' } };

function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 3500);
}

function renderLogin(error = '') {
  who.innerHTML = '';
  app.innerHTML = `
    <form id="login" class="card narrow">
      <h1>Organiser sign in</h1>
      <label>Username<input name="username" autocomplete="username" required autofocus /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <button class="primary" type="submit">Sign in</button>
    </form>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(fd.get('username')),
      password: fd.get('password'),
    });
    if (error) return renderLogin(friendlyError(error));
    boot();
  });
}

async function loadData() {
  const [teams, settings, reports] = await Promise.all([
    supabase.from('teams').select('user_id, username, team_name').order('username'),
    supabase.from('settings').select('submissions_open, notice').maybeSingle(),
    supabase.from('reports')
      .select('*, teams(username, team_name), report_reviews(verdict, points, note, reviewed_at)')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true })
      .limit(5000),
  ]);
  for (const r of [teams, settings, reports]) if (r.error) throw r.error;
  state.teams = teams.data;
  state.settings = settings.data;
  state.reports = reports.data.map((r) => ({
    ...r,
    review: Array.isArray(r.report_reviews) ? r.report_reviews[0] : r.report_reviews,
  }));
}

function summaryRows() {
  const by = new Map(state.teams.map((t) => [t.user_id, { team: t, total: 0, valid: 0, invalid: 0, duplicate: 0, pending: 0, points: 0, last: null }]));
  for (const r of state.reports) {
    const s = by.get(r.team_id);
    if (!s) continue;
    s.total++;
    const v = r.review?.verdict;
    if (v) s[v]++; else s.pending++;
    s.points += r.review?.points || 0;
    if (!s.last || r.submitted_at > s.last) s.last = r.submitted_at;
  }
  return [...by.values()].sort((a, b) => b.points - a.points || b.valid - a.valid || a.team.username.localeCompare(b.team.username));
}

function filtered() {
  const { team, verdict, q } = state.filter;
  const needle = q.trim().toLowerCase();
  return state.reports.filter((r) => {
    if (team && r.team_id !== team) return false;
    const v = r.review?.verdict || 'pending';
    if (verdict && v !== verdict) return false;
    if (needle) {
      const hay = [r.title, r.observed, r.location, r.steps, r.fix, r.code_ref, r.diff].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function reportHtml(r) {
  const v = r.review?.verdict || 'pending';
  const block = (label, val, mono) => val ? `<div class="kv"><div class="k">${label}</div><div class="v ${mono ? 'mono pre' : 'pre'}">${esc(val)}</div></div>` : '';
  return `
    <article class="report" data-id="${r.id}">
      <header>
        <div class="row between">
          <h3><span class="tag">#${r.id}</span> ${esc(r.title)}</h3>
          <span class="pill ${v}">${v}</span>
        </div>
        <div class="meta"><b>${esc(r.teams?.team_name)}</b> (${esc(r.teams?.username)}) · submitted <b>${fmtTime(r.submitted_at)}</b>
          <span class="dim">(${esc(r.submitted_at)})</span></div>
      </header>
      ${block('Observed', r.observed)}
      ${block('Where', r.location)}
      ${block('Reproduce', r.steps)}
      ${block('Fix', r.fix)}
      ${block('Files / lines', r.code_ref, true)}
      ${r.diff ? `<details><summary>Code change</summary><div class="v mono pre">${esc(r.diff)}</div></details>` : ''}
      <form class="review row wrap">
        <select name="verdict">
          ${['pending', 'valid', 'invalid', 'duplicate'].map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
        <input name="points" type="number" min="-100" max="100" placeholder="points" value="${r.review?.points ?? ''}" class="pts" />
        <input name="note" placeholder="note (organisers only)" maxlength="2000" value="${esc(r.review?.note ?? '')}" class="grow" />
        <button class="primary small" type="submit">Save</button>
      </form>
    </article>`;
}

function render() {
  const { settings, teams, filter } = state;
  who.innerHTML = `<span>Organiser</span><button id="logout" class="ghost small">Sign out</button>`;
  document.getElementById('logout').onclick = async () => { await supabase.auth.signOut(); renderLogin(); };
  const list = filtered();
  const rows = summaryRows();

  app.innerHTML = `
    <section class="card">
      <div class="row between wrap">
        <h2>Event controls</h2>
        <button id="refresh" class="ghost small">Refresh</button>
      </div>
      <form id="settings" class="row wrap">
        <label class="check"><input type="checkbox" name="open" ${settings.submissions_open ? 'checked' : ''} /> Submissions open</label>
        <input name="notice" class="grow" maxlength="500" placeholder="Notice shown to all teams (optional)" value="${esc(settings.notice ?? '')}" />
        <button class="primary small" type="submit">Save</button>
      </form>
    </section>

    <section class="card">
      <div class="row between wrap">
        <h2>Teams</h2>
        <button id="csv" class="ghost small">Export all reports (CSV)</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Team</th><th>Reports</th><th>Valid</th><th>Invalid</th><th>Duplicate</th><th>Pending</th><th>Points</th><th>Last submission</th></tr></thead>
        <tbody>${rows.map((s) => `<tr data-team="${s.team.user_id}" class="clickable">
          <td><b>${esc(s.team.team_name)}</b> <span class="dim">${esc(s.team.username)}</span></td>
          <td>${s.total}</td><td>${s.valid}</td><td>${s.invalid}</td><td>${s.duplicate}</td><td>${s.pending}</td><td><b>${s.points}</b></td>
          <td>${fmtTime(s.last)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No teams loaded yet. Run the import script.</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="card">
      <h2>Reports</h2>
      <div class="row wrap filters">
        <select id="f-team"><option value="">All teams</option>${teams.map((t) => `<option value="${t.user_id}" ${filter.team === t.user_id ? 'selected' : ''}>${esc(t.team_name)}</option>`).join('')}</select>
        <select id="f-verdict">${['', 'pending', 'valid', 'invalid', 'duplicate'].map((o) => `<option value="${o}" ${filter.verdict === o ? 'selected' : ''}>${o || 'Any verdict'}</option>`).join('')}</select>
        <input id="f-q" class="grow" placeholder="Search text, files, diffs…" value="${esc(filter.q)}" />
        <span class="dim">${list.length} shown</span>
      </div>
      <div id="reports">${list.map(reportHtml).join('') || '<p class="empty">No reports match.</p>'}</div>
    </section>`;

  document.getElementById('refresh').onclick = refresh;
  document.getElementById('csv').onclick = exportCsv;
  document.getElementById('settings').addEventListener('submit', saveSettings);
  document.querySelectorAll('tr[data-team]').forEach((tr) => tr.addEventListener('click', () => { state.filter.team = tr.dataset.team; render(); document.getElementById('reports').scrollIntoView({ behavior: 'smooth' }); }));
  document.getElementById('f-team').onchange = (e) => { state.filter.team = e.target.value; render(); };
  document.getElementById('f-verdict').onchange = (e) => { state.filter.verdict = e.target.value; render(); };
  const q = document.getElementById('f-q');
  q.oninput = (e) => {
    state.filter.q = e.target.value;
    clearTimeout(render.t);
    render.t = setTimeout(() => { const pos = e.target.selectionStart; render(); const n = document.getElementById('f-q'); n.focus(); n.setSelectionRange(pos, pos); }, 250);
  };
  document.getElementById('reports').addEventListener('submit', saveReview);
}

async function saveSettings(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const { error } = await supabase.from('settings')
    .update({ submissions_open: fd.get('open') === 'on', notice: String(fd.get('notice') || '').trim() || null })
    .eq('id', true);
  if (error) return toast(friendlyError(error), 'err');
  toast('Settings saved.');
  refresh();
}

async function saveReview(e) {
  e.preventDefault();
  const form = e.target;
  const id = Number(form.closest('.report').dataset.id);
  const fd = new FormData(form);
  const verdict = fd.get('verdict');
  let error;
  if (verdict === 'pending') {
    ({ error } = await supabase.from('report_reviews').delete().eq('report_id', id));
  } else {
    const pts = String(fd.get('points') || '').trim();
    ({ error } = await supabase.from('report_reviews').upsert({
      report_id: id,
      verdict,
      points: pts === '' ? null : Number(pts),
      note: String(fd.get('note') || '').trim() || null,
      reviewed_by: state.user.id,
      reviewed_at: new Date().toISOString(),
    }));
  }
  if (error) return toast(friendlyError(error), 'err');
  toast(`Report #${id} marked ${verdict}.`);
  const keepScroll = window.scrollY;
  await refresh();
  window.scrollTo(0, keepScroll);
}

function exportCsv() {
  const cols = ['id', 'team', 'username', 'submitted_at', 'created_at', 'title', 'observed', 'location', 'steps', 'fix', 'code_ref', 'diff', 'verdict', 'points', 'note', 'reviewed_at'];
  const cell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = [cols.join(',')];
  for (const r of state.reports) {
    lines.push([r.id, r.teams?.team_name, r.teams?.username, r.submitted_at, r.created_at, r.title, r.observed, r.location, r.steps, r.fix, r.code_ref, r.diff,
      r.review?.verdict || 'pending', r.review?.points, r.review?.note, r.review?.reviewed_at].map(cell).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `obscura-r2-reports-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function refresh() {
  try {
    await loadData();
    render();
  } catch (err) {
    app.innerHTML = `<div class="card narrow"><p class="error">${esc(friendlyError(err))}</p></div>`;
  }
}

async function boot() {
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }
  const { data } = await supabase.auth.getSession();
  state.user = data.session?.user || null;
  if (!state.user) return renderLogin();
  const { data: org, error } = await supabase.from('organisers').select('user_id').eq('user_id', state.user.id).maybeSingle();
  if (error || !org) {
    who.innerHTML = `<button id="logout" class="ghost small">Sign out</button>`;
    document.getElementById('logout').onclick = async () => { await supabase.auth.signOut(); renderLogin(); };
    app.innerHTML = `<div class="card narrow"><h2>Not an organiser account</h2><p class="muted">This page is for organisers only.</p></div>`;
    return;
  }
  await refresh();
}

supabase?.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') renderLogin(); });
boot();
