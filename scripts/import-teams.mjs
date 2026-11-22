#!/usr/bin/env node
// Create or update team and organiser logins from a CSV file.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-teams.mjs teams.csv
//
// CSV columns: username,password,team_name,role   (role = team | organiser, default team)
// Re-running is safe: existing users get their password and team name updated.
// Flags: --dry-run  print what would happen without changing anything.

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

loadDotEnv();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const domain = process.env.LOGIN_DOMAIN || process.env.VITE_LOGIN_DOMAIN || 'teams.obscura.local';

if (!file) { console.error('Usage: node scripts/import-teams.mjs teams.csv [--dry-run]'); process.exit(1); }
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env or the shell).'); process.exit(1); }

const [header, ...body] = parseCsv(readFileSync(file, 'utf8'));
const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
for (const col of ['username', 'password']) {
  if (!(col in idx)) { console.error(`CSV is missing the "${col}" column.`); process.exit(1); }
}

const entries = body.map((r, n) => {
  const get = (c) => (idx[c] === undefined ? '' : String(r[idx[c]] ?? '').trim());
  const username = get('username').toLowerCase();
  const role = (get('role') || 'team').toLowerCase();
  const e = { line: n + 2, username, password: get('password'), team_name: get('team_name') || username, role };
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(username)) e.error = 'username must be 2-63 chars: letters, digits, . _ -';
  else if (e.password.length < 6) e.error = 'password must be at least 6 characters';
  else if (!['team', 'organiser', 'organizer'].includes(role)) e.error = 'role must be team or organiser';
  if (role === 'organizer') e.role = 'organiser';
  return e;
});

const bad = entries.filter((e) => e.error);
if (bad.length) {
  for (const e of bad) console.error(`line ${e.line} (${e.username || '?'}): ${e.error}`);
  process.exit(1);
}
const dupes = entries.map((e) => e.username).filter((u, i, a) => a.indexOf(u) !== i);
if (dupes.length) { console.error(`Duplicate usernames: ${[...new Set(dupes)].join(', ')}`); process.exit(1); }

if (dryRun) {
  for (const e of entries) console.log(`[dry-run] ${e.role.padEnd(9)} ${e.username}  ->  ${e.username}@${domain}  "${e.team_name}"`);
  process.exit(0);
}

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Index existing auth users by email.
const existing = new Map();
for (let page = 1; ; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  for (const u of data.users) existing.set(u.email?.toLowerCase(), u);
  if (data.users.length < 1000) break;
}

let created = 0, updated = 0;
for (const e of entries) {
  const email = `${e.username}@${domain}`;
  let user = existing.get(email);
  if (user) {
    const { data, error } = await sb.auth.admin.updateUserById(user.id, {
      password: e.password, email_confirm: true, user_metadata: { username: e.username, team_name: e.team_name },
    });
    if (error) { console.error(`${e.username}: ${error.message}`); process.exitCode = 1; continue; }
    user = data.user; updated++;
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email, password: e.password, email_confirm: true, user_metadata: { username: e.username, team_name: e.team_name },
    });
    if (error) { console.error(`${e.username}: ${error.message}`); process.exitCode = 1; continue; }
    user = data.user; created++;
  }

  if (e.role === 'organiser') {
    const { error } = await sb.from('organisers').upsert({ user_id: user.id, username: e.username });
    if (error) { console.error(`${e.username}: ${error.message}`); process.exitCode = 1; continue; }
    await sb.from('teams').delete().eq('user_id', user.id);
  } else {
    const { error } = await sb.from('teams').upsert({ user_id: user.id, username: e.username, team_name: e.team_name });
    if (error) { console.error(`${e.username}: ${error.message}`); process.exitCode = 1; continue; }
    await sb.from('organisers').delete().eq('user_id', user.id);
  }
  console.log(`ok  ${e.role.padEnd(9)} ${e.username}  "${e.team_name}"`);
}
console.log(`\nDone: ${created} created, ${updated} updated.`);
