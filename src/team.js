import './style.css';
import { supabase, configured, usernameToEmail, esc, fmtTime, friendlyError, notConfiguredHtml } from './supabase.js';

const app = document.getElementById('app');
const who = document.getElementById('who');
const toastEl = document.getElementById('toast');

const FIELDS = [
  { name: 'title', label: 'Short title', hint: 'One line that names the problem.', type: 'input', required: true, min: 3, max: 200 },
  { name: 'observed', label: 'What did you see?', hint: 'Describe the wrong behaviour and what you expected instead.', type: 'textarea', rows: 4, required: true, min: 10, max: 5000 },
  { name: 'location', label: 'Where in the game?', hint: 'Screen, room, menu, feature or moment where it shows up.', type: 'input', max: 500 },
  { name: 'steps', label: 'How to make it happen', hint: 'Steps someone else can follow to see it.', type: 'textarea', rows: 3, max: 3000 },
  { name: 'fix', label: 'How did you fix it?', hint: 'Explain the cause and what you changed.', type: 'textarea', rows: 5, required: true, min: 10, max: 8000 },
  { name: 'code_ref', label: 'File(s) and line(s) changed', hint: 'For example: path/to/file.js:120', type: 'input', max: 500 },
  { name: 'diff', label: 'Code change or diff', hint: 'Paste the diff or the changed lines.', type: 'textarea', rows: 6, max: 20000, mono: true },
];

let state = { user: null, team: null, settings: null, reports: [], editingId: null };

function toast(msg, kind = 'ok') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 3500);
}

const draftKey = () => `obscura-draft-${state.user?.id}`;
function saveDraft(form) {
  if (state.editingId) return;
  try { localStorage.setItem(draftKey(), JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {}
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch {}
}

// ------------------------------------------------------------------ login

function renderLogin(error = '') {
  who.innerHTML = '';
  app.innerHTML = `
    <form id="login" class="card narrow" autocomplete="on">
      <h1>Team sign in</h1>
      <p class="muted">Use the username and password your organisers gave you.</p>
      <label>Username<input name="username" autocomplete="username" required autofocus /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <button class="primary" type="submit">Sign in</button>
    </form>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    const fd = new FormData(e.target);
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(fd.get('username')),
      password: fd.get('password'),
    });
    if (error) return renderLogin(friendlyError(error));
    boot();
  });
}

// ------------------------------------------------------------------ dashboard

async function loadData() {
  const [team, settings, reports] = await Promise.all([
    supabase.from('teams').select('username, team_name').eq('user_id', state.user.id).maybeSingle(),
    supabase.from('settings').select('submissions_open, notice').maybeSingle(),
    supabase.from('reports').select('*').order('created_at', { ascending: false }),
  ]);
  for (const r of [team, settings, reports]) if (r.error) throw r.error;
  state.team = team.data;
  state.settings = settings.data || { submissions_open: false };
  state.reports = reports.data || [];
}

function fieldHtml(f, values) {
  const v = esc(values?.[f.name] ?? '');
  const attrs = `name="${f.name}" ${f.required ? 'required' : ''} ${f.min ? `minlength="${f.min}"` : ''} maxlength="${f.max}"`;
  const control = f.type === 'textarea'
    ? `<textarea ${attrs} rows="${f.rows}" class="${f.mono ? 'mono' : ''}" spellcheck="${f.mono ? 'false' : 'true'}">${v}</textarea>`
    : `<input ${attrs} value="${v}" />`;
  return `<label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}
    <span class="hint">${esc(f.hint)}</span>${control}</label>`;
}

function reportHtml(r) {
  const open = state.settings.submissions_open;
  const edited = r.updated_at && new Date(r.updated_at) - new Date(r.created_at) > 2000;
  const block = (label, val, mono) => val ? `<div class="kv"><div class="k">${label}</div><div class="v ${mono ? 'mono pre' : 'pre'}">${esc(val)}</div></div>` : '';
  return `
    <article class="report" data-id="${r.id}">
      <header>
        <h3>${esc(r.title)}</h3>
        <div class="meta">Submitted ${fmtTime(r.created_at)}${edited ? ` · edited ${fmtTime(r.updated_at)}` : ''}</div>
      </header>
      <details>
        <summary>Show details</summary>
        ${block('What we saw', r.observed)}
        ${block('Where', r.location)}
        ${block('How to make it happen', r.steps)}
        ${block('How we fixed it', r.fix)}
        ${block('Files and lines', r.code_ref, true)}
        ${block('Code change', r.diff, true)}
      </details>
      ${open ? `<div class="actions">
        <button class="ghost" data-act="edit">Edit</button>
        <button class="ghost danger" data-act="delete">Delete</button>
      </div>` : ''}
    </article>`;
}

function renderDashboard() {
  const { team, settings, reports, editingId } = state;
  who.innerHTML = `<span>${esc(team?.team_name || 'Team')}</span><button id="logout" class="ghost small">Sign out</button>`;
  document.getElementById('logout').onclick = async () => { await supabase.auth.signOut(); renderLogin(); };

  if (!team) {
    app.innerHTML = `<div class="card narrow"><h2>This is not a team account</h2>
      <p class="muted">Sign in with the team username your organisers gave you.</p></div>`;
    return;
  }

  const editing = editingId ? reports.find((r) => r.id === editingId) : null;
  const values = editing || loadDraft() || {};
  const open = settings.submissions_open;

  app.innerHTML = `
    ${settings.notice ? `<div class="banner">${esc(settings.notice)}</div>` : ''}
    ${!open ? `<div class="banner closed">Submissions are closed. You can still read your reports.</div>` : ''}
    <div class="grid">
      <section class="card">
        ${open ? `
          <h2>${editing ? 'Edit report' : 'Report a bug'}</h2>
          <p class="muted">Submit one report for each bug you found and fixed. Fields with <span class="req">*</span> are required.</p>
          <form id="report">${FIELDS.map((f) => fieldHtml(f, values)).join('')}
            <div class="row">
              <button class="primary" type="submit">${editing ? 'Save changes' : 'Submit report'}</button>
              ${editing ? '<button type="button" id="cancel" class="ghost">Cancel</button>' : '<button type="button" id="clear" class="ghost">Clear form</button>'}
            </div>
          </form>` : `<h2>Report a bug</h2><p class="muted">The form is closed.</p>`}
      </section>
      <section class="card">
        <h2>Your reports</h2>
        <p class="muted">Only your team can see these.</p>
        <div id="list">${reports.length ? reports.map(reportHtml).join('') : '<p class="empty">Nothing submitted yet.</p>'}</div>
      </section>
    </div>`;

  const form = document.getElementById('report');
  if (form) {
    form.addEventListener('input', () => saveDraft(form));
    form.addEventListener('submit', onSubmit);
    document.getElementById('cancel')?.addEventListener('click', () => { state.editingId = null; renderDashboard(); });
    document.getElementById('clear')?.addEventListener('click', () => { clearDraft(); form.reset(); form.querySelectorAll('input,textarea').forEach((el) => (el.value = '')); });
  }
  document.getElementById('list').addEventListener('click', onListClick);
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  const payload = {};
  for (const f of FIELDS) {
    const v = String(new FormData(form).get(f.name) || '').trim();
    payload[f.name] = v || null;
  }
  for (const f of FIELDS) {
    if (f.required && (!payload[f.name] || payload[f.name].length < (f.min || 1))) {
      return toast(`"${f.label}" needs at least ${f.min} characters.`, 'err');
    }
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const q = state.editingId
    ? supabase.from('reports').update(payload).eq('id', state.editingId).select().single()
    : supabase.from('reports').insert(payload).select().single();
  const { error } = await q;
  if (error) {
    btn.disabled = false;
    btn.textContent = state.editingId ? 'Save changes' : 'Submit report';
    return toast(friendlyError(error), 'err');
  }
  toast(state.editingId ? 'Report updated.' : 'Report submitted.');
  if (!state.editingId) clearDraft();
  state.editingId = null;
  await refresh();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.report').dataset.id);
  if (btn.dataset.act === 'edit') {
    state.editingId = id;
    renderDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (btn.dataset.act === 'delete') {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Click again to delete';
      setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete'; }, 4000);
      return;
    }
    const { error } = await supabase.from('reports').delete().eq('id', id);
    if (error) return toast(friendlyError(error), 'err');
    toast('Report deleted.');
    if (state.editingId === id) state.editingId = null;
    await refresh();
  }
}

async function refresh() {
  try {
    await loadData();
    renderDashboard();
  } catch (err) {
    app.innerHTML = `<div class="card narrow"><h2>Something went wrong</h2><p class="error">${esc(friendlyError(err))}</p>
      <button class="primary" onclick="location.reload()">Reload</button></div>`;
  }
}

async function boot() {
  if (!configured) { app.innerHTML = notConfiguredHtml(); return; }
  const { data } = await supabase.auth.getSession();
  state.user = data.session?.user || null;
  if (!state.user) return renderLogin();
  await refresh();
}

supabase?.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') renderLogin(); });
boot();
