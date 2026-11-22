import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const LOGIN_DOMAIN = import.meta.env.VITE_LOGIN_DOMAIN || 'teams.obscura.local';
export const configured = Boolean(url && key);

export const supabase = configured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

export function usernameToEmail(username) {
  const u = username.trim().toLowerCase();
  return u.includes('@') ? u : `${u}@${LOGIN_DOMAIN}`;
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function friendlyError(error) {
  const msg = error?.message || String(error);
  if (/Invalid login credentials/i.test(msg)) return 'Wrong username or password.';
  if (/row-level security/i.test(msg)) return 'Not allowed. Submissions may be closed, or this account is not a team account.';
  if (/check constraint/i.test(msg)) return 'One of the fields is too short or too long.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Network error. Check your connection and try again.';
  return msg;
}

export function notConfiguredHtml() {
  return `<div class="card narrow"><h2>Portal not configured</h2>
    <p class="muted">Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and rebuild.</p></div>`;
}
