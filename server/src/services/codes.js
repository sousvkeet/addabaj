// One-time codes sent by email (see services/mail.js): six digits, good for
// 15 minutes and five tries. They're kept only as keyed hashes, a new one
// can't be sent for a minute, and an address (or account) gets at most a few a
// day, so codes can't be guessed or used to flood someone's inbox.
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db.js';

export const CODE_MINUTES = 15;
const TRIES = 5;
/** Seconds before another code can be sent. */
export const RESEND_SECONDS = 60;
/** Codes one address, or one account, gets in a day. */
const PER_DAY = 6;

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const seal = (kind, id, code) => createHmac('sha256', config.jwtSecret).update(`${kind}:${id}:${code}`).digest('hex');
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/**
 * Checks a code: { result: 'ok' }, or 'wrong' (with tries left), 'expired' or
 * 'used-up' (used, too many wrong tries, or none sent). A try is taken first,
 * in one step, so guesses sent all at once still get only five between them.
 */
async function check(table, keyColumn, key, kind, code) {
  const row = await one(
    `UPDATE ${table} SET attempts = attempts + 1
     WHERE ${keyColumn} = $1 AND code_hash <> '' AND attempts < $2
     RETURNING code_hash, attempts, expires_at`,
    [key, TRIES],
  );
  if (!row) return { result: 'used-up' };
  if (row.expires_at < new Date()) return { result: 'expired' };
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given) || !same(seal(kind, key, given), row.code_hash)) {
    if (row.attempts >= TRIES) await query(`UPDATE ${table} SET code_hash = '' WHERE ${keyColumn} = $1`, [key]);
    return { result: 'wrong', left: TRIES - row.attempts };
  }
  await query(`UPDATE ${table} SET code_hash = '' WHERE ${keyColumn} = $1`, [key]);
  return { result: 'ok' };
}

// ── Sign-ups waiting for their code ───────────────────────────────────

/** Codes sent to this address in the last day, across sign-ups. */
async function sentToday(email) {
  const { n } = await one(
    `SELECT coalesce(sum(sends), 0)::int AS n FROM pending_signups WHERE lower(email) = $1 AND created_at > now() - interval '1 day'`,
    [email],
  );
  return n;
}

/**
 * Starts a sign-up that waits for the code sent to its email: { id, token,
 * code }, the token for the browser that signed up. Null when that address
 * already had enough codes today.
 */
export async function startSignup({ email, name, passwordHash }) {
  await query(`DELETE FROM pending_signups WHERE created_at < now() - interval '1 day'`);
  if ((await sentToday(email)) >= PER_DAY) return null;
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const code = newCode();
  await query(
    `INSERT INTO pending_signups (id, token_hash, email, name, password_hash, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
    [id, tokenHash(token), email, name, passwordHash, seal('signup', id, code), CODE_MINUTES],
  );
  return { id, token, code };
}

/** The sign-up a browser is waiting on (by its token), if it's still there. */
export async function findSignup(token) {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  return one(
    `SELECT id, email, name, password_hash, sent_at FROM pending_signups
     WHERE token_hash = $1 AND created_at > now() - interval '1 day'`,
    [tokenHash(token)],
  );
}

/** Gives up on a sign-up (its email couldn't be sent). */
export const dropSignup = (id) => query('DELETE FROM pending_signups WHERE id = $1', [id]);

/** A new code for a waiting sign-up: { code }, { wait } (seconds), or { limited } (enough today). */
export async function resendSignup(signup) {
  const since = (Date.now() - signup.sent_at.getTime()) / 1000;
  if (since < RESEND_SECONDS) return { wait: Math.ceil(RESEND_SECONDS - since) };
  if ((await sentToday(signup.email)) >= PER_DAY) return { limited: true };
  const code = newCode();
  const row = await one(
    `UPDATE pending_signups
     SET code_hash = $2, expires_at = now() + make_interval(mins => $3), attempts = 0, sends = sends + 1, sent_at = now()
     WHERE id = $1 AND sent_at < now() - make_interval(secs => $4)
     RETURNING id`,
    [signup.id, seal('signup', signup.id, code), CODE_MINUTES, RESEND_SECONDS],
  );
  return row ? { code } : { wait: RESEND_SECONDS };
}

export const checkSignup = (id, code) => check('pending_signups', 'id', id, 'signup', code);

/** The account is made: other sign-ups waiting on the same address are moot. */
export const finishSignups = (email) => query('DELETE FROM pending_signups WHERE lower(email) = $1', [email]);

// ── Forgotten passwords ───────────────────────────────────────────────

/** A new password reset code for this person; null if one went out under a minute ago, or enough today. */
export async function startReset(userId) {
  const code = newCode();
  const row = await one(
    `INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = now(),
       sends = CASE WHEN password_resets.window_start < now() - interval '1 day' THEN 1 ELSE password_resets.sends + 1 END,
       window_start = CASE WHEN password_resets.window_start < now() - interval '1 day' THEN now() ELSE password_resets.window_start END
     WHERE password_resets.sent_at < now() - make_interval(secs => $4)
       AND (password_resets.window_start < now() - interval '1 day' OR password_resets.sends < $5)
     RETURNING user_id`,
    [userId, seal('reset', userId, code), CODE_MINUTES, RESEND_SECONDS, PER_DAY],
  );
  return row ? code : null;
}

export const checkReset = (userId, code) => check('password_resets', 'user_id', userId, 'reset', code);
