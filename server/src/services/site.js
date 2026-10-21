// The host admin's side of the site: the built-in admin account, accounts
// that are switched off, and site-wide settings (sign-ups, announcement).
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one, query } from '../db.js';
import { getIO } from '../realtime.js';

/** The account created on first start, so the host can always get in. */
const ADMIN_LOGIN = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

/** "admin", or anything short, is a password strangers would guess, so it has to be changed. */
export const isWeakAdminPassword = (password) => password === 'admin' || password.length < 8;

const DEFAULTS = { allowSignups: true, announcement: null };
let settings = { ...DEFAULTS };
const disabled = new Set();
/** userId -> seconds: logins issued before then were signed out by a password change. */
const validAfter = new Map();

/** Creates the host admin account if there is no host admin yet. */
export async function ensureHostAdmin() {
  const admin = await one(`SELECT id FROM users WHERE site_role = 'admin' AND disabled_at IS NULL LIMIT 1`);
  if (admin) return;
  const existing = await one('SELECT id FROM users WHERE lower(email) = $1', [ADMIN_LOGIN]);
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const mustChange = isWeakAdminPassword(ADMIN_PASSWORD);
  if (existing) {
    await query(
      `UPDATE users SET site_role = 'admin', disabled_at = NULL, password_hash = $2, must_change_password = $3 WHERE id = $1`,
      [existing.id, hash, mustChange],
    );
  } else {
    await query(
      `INSERT INTO users (email, name, password_hash, avatar_hue, site_role, must_change_password)
       VALUES ($1, 'Host Admin', $2, 268, 'admin', $3)`,
      [ADMIN_LOGIN, hash, mustChange],
    );
  }
  console.log(
    `Host admin ready: log in as "${ADMIN_LOGIN}"${mustChange ? ` with the password "${ADMIN_PASSWORD}", then change it` : ''}.`,
  );
}

export async function loadSite() {
  const { rows } = await query('SELECT key, value FROM site_settings');
  settings = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  disabled.clear();
  for (const r of (await query('SELECT id FROM users WHERE disabled_at IS NOT NULL')).rows) disabled.add(r.id);
  validAfter.clear();
  for (const r of (await query('SELECT id, sessions_valid_after FROM users WHERE sessions_valid_after IS NOT NULL')).rows) {
    validAfter.set(r.id, Math.floor(r.sessions_valid_after.getTime() / 1000));
  }
}

export const getSettings = () => settings;

/** What every signed-in person sees (the announcement banner). */
export const publicSite = () => ({ announcement: settings.announcement });

export async function saveSettings(patch) {
  const next = { ...settings };
  if (typeof patch.allowSignups === 'boolean') next.allowSignups = patch.allowSignups;
  if (patch.announcement !== undefined) {
    const text = typeof patch.announcement === 'string' ? patch.announcement.trim().slice(0, 280) : '';
    // A new id lets people who dismissed the last one see the next.
    next.announcement = text ? { id: randomUUID(), text, at: new Date().toISOString() } : null;
  }
  for (const key of ['allowSignups', 'announcement']) {
    await query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(next[key])],
    );
  }
  const announcementChanged = settings.announcement?.id !== next.announcement?.id;
  settings = next;
  if (announcementChanged) getIO()?.emit('site:settings', publicSite());
  return settings;
}

export const isDisabled = (userId) => disabled.has(userId);

/** Whether a login issued at `issuedAt` (seconds) still counts for this person. */
export const sessionValid = (userId, issuedAt) => !disabled.has(userId) && (issuedAt ?? 0) >= (validAfter.get(userId) ?? 0);

/** Signs a person out everywhere (their password changed); returns when it took effect. */
/** Every login cookie issued before now stops working (a device carrying on gets a fresh one). */
export async function retireLogins(userId) {
  // This server's clock, the same one that dates new logins.
  const seconds = Math.floor(Date.now() / 1000);
  await query('UPDATE users SET sessions_valid_after = to_timestamp($2) WHERE id = $1', [userId, seconds]);
  validAfter.set(userId, seconds);
}

export async function endSessions(userId) {
  await retireLogins(userId);
  // Their phones stop getting notifications until they sign in again.
  await query('DELETE FROM push_devices WHERE user_id = $1', [userId]);
}
export function markDisabled(userId, off) {
  if (off) disabled.add(userId);
  else disabled.delete(userId);
}
