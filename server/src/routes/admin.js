// The host admin's control panel: what's happening on the site, people
// (switch off, promote, reset passwords, remove), rooms, and site settings.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { AppError, assertUuid, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getIO, presence, userChannel } from '../realtime.js';
import { deleteRoom, postSystemMessage } from '../services/rooms.js';
import { endSessions, getSettings, markDisabled, saveSettings } from '../services/site.js';
import { publicUser } from '../services/users.js';
import { calls } from '../socket/calls.js';
import { live } from '../socket/live.js';
import { voice } from '../socket/voice.js';
import { replaceWatch } from '../socket/watch.js';
import { newPassword, nextHue } from './auth.js';

export const adminRouter = Router();

adminRouter.use(async (req, _res, next) => {
  try {
    const me = await one('SELECT site_role, must_change_password, disabled_at FROM users WHERE id = $1', [req.userId]);
    if (!me || me.site_role !== 'admin' || me.disabled_at) throw forbidden('Only the host admin can do that.');
    if (config.isProd && me.must_change_password) {
      throw forbidden('Change the default admin password first (account menu, then "Change password").');
    }
    next();
  } catch (err) {
    next(err);
  }
});

const like = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const page = (req) => ({
  q: String(req.query.q ?? '').trim().slice(0, 80),
  limit: Math.min(100, Math.max(1, Number(req.query.limit) || 50)),
  offset: Math.max(0, Number(req.query.offset) || 0),
});

/** Ends every connection of a person (their calls and voice end with it). */
const disconnect = (userId) => getIO()?.in(userChannel(userId)).disconnectSockets(true);

async function otherActiveAdmins(userId) {
  const { n } = await one(
    `SELECT count(*)::int AS n FROM users WHERE site_role = 'admin' AND disabled_at IS NULL AND id <> $1`,
    [userId],
  );
  return n;
}

// ── Overview ──────────────────────────────────────────────────────────

adminRouter.get('/overview', async (_req, res) => {
  const [users, rooms, messages, files, series] = await Promise.all([
    one(`SELECT count(*)::int AS total,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_this_week,
                count(*) FILTER (WHERE disabled_at IS NOT NULL)::int AS disabled,
                count(*) FILTER (WHERE site_role = 'admin')::int AS admins
         FROM users`),
    one(`SELECT count(*)::int AS total,
                count(*) FILTER (WHERE watch IS NOT NULL)::int AS watching,
                (SELECT count(DISTINCT room_id)::int FROM room_messages WHERE created_at > now() - interval '24 hours') AS active_today
         FROM rooms`),
    one(`SELECT (SELECT count(*) FROM dm_messages)::int + (SELECT count(*) FROM room_messages)::int AS total,
                (SELECT count(*) FROM dm_messages WHERE created_at >= date_trunc('day', now()))::int
                  + (SELECT count(*) FROM room_messages WHERE created_at >= date_trunc('day', now()))::int AS today`),
    one(`SELECT count(*)::int AS count, coalesce(sum(size), 0)::bigint AS bytes FROM attachments`),
    query(`WITH days AS (
             SELECT generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS day
           )
           SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  (SELECT count(*) FROM users u WHERE date_trunc('day', u.created_at) = d.day)::int AS signups,
                  ((SELECT count(*) FROM dm_messages m WHERE date_trunc('day', m.created_at) = d.day)
                    + (SELECT count(*) FROM room_messages m WHERE date_trunc('day', m.created_at) = d.day))::int AS messages
           FROM days d ORDER BY d.day`),
  ]);
  res.json({
    users: { total: users.total, newThisWeek: users.new_this_week, disabled: users.disabled, admins: users.admins, online: presence.list().length },
    rooms: { total: rooms.total, activeToday: rooms.active_today, watching: rooms.watching },
    messages: { total: messages.total, today: messages.today },
    files: { count: files.count, bytes: Number(files.bytes) },
    now: { calls: calls.activeCount(), inVoice: voice.totalParticipants(), liveStreams: live.count() },
    days: series.rows,
    server: { uptime: Math.round(process.uptime()), memory: process.memoryUsage().rss, node: process.version },
    signupsOpen: getSettings().allowSignups,
  });
});

// ── People ────────────────────────────────────────────────────────────

const adminUser = (r) => ({
  ...publicUser(r),
  createdAt: r.created_at,
  siteAdmin: r.site_role === 'admin',
  disabled: !!r.disabled_at,
  defaultPassword: r.site_role === 'admin' && r.must_change_password,
  rooms: r.rooms,
  messages: r.messages,
});

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.avatar_hue, u.last_seen_at, u.created_at, u.site_role, u.disabled_at, u.must_change_password,
         (SELECT count(*)::int FROM room_members m WHERE m.user_id = u.id) AS rooms,
         ((SELECT count(*) FROM dm_messages d WHERE d.sender_id = u.id)
           + (SELECT count(*) FROM room_messages r WHERE r.sender_id = u.id))::int AS messages
  FROM users u`;

adminRouter.get('/users', async (req, res) => {
  const { q, limit, offset } = page(req);
  const filter = String(req.query.filter ?? 'all');
  const where = ['($1 = \'\' OR u.name ILIKE $2 OR u.email ILIKE $2)'];
  const params = [q, like(q)];
  if (filter === 'online') {
    params.push(presence.list());
    where.push(`u.id = ANY($${params.length}::uuid[])`);
  } else if (filter === 'admins') where.push(`u.site_role = 'admin'`);
  else if (filter === 'disabled') where.push('u.disabled_at IS NOT NULL');
  const { rows } = await query(
    `${USER_SELECT.replace('FROM users u', ', count(*) OVER () AS total FROM users u')}
     WHERE ${where.join(' AND ')}
     ORDER BY u.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ items: rows.map(adminUser), total: Number(rows[0]?.total ?? 0) });
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter their name.').max(40, 'Keep the name under 40 characters.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  password: newPassword,
  siteAdmin: z.boolean().optional(),
});

adminRouter.post('/users', async (req, res) => {
  const input = createSchema.parse(req.body);
  try {
    const { id } = await one(
      `INSERT INTO users (email, name, password_hash, avatar_hue, site_role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.email, input.name, await bcrypt.hash(input.password, 10), await nextHue(), input.siteAdmin ? 'admin' : 'user'],
    );
    res.status(201).json({ user: adminUser(await one(`${USER_SELECT} WHERE u.id = $1`, [id])) });
  } catch (err) {
    if (err.code === '23505') throw conflict('Someone already has an account with this email.');
    throw err;
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  siteAdmin: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

adminRouter.patch('/users/:id', async (req, res) => {
  const id = assertUuid(req.params.id, 'person');
  const input = updateSchema.parse(req.body);
  const target = await one('SELECT id, site_role, disabled_at FROM users WHERE id = $1', [id]);
  if (!target) throw notFound("That person doesn't exist.");
  const self = id === req.userId;
  if (self && (input.disabled || input.siteAdmin === false)) throw badRequest("You can't switch off or demote your own account.");
  const losingAdmin = target.site_role === 'admin' && (input.siteAdmin === false || input.disabled);
  if (losingAdmin && (await otherActiveAdmins(id)) === 0) throw badRequest('The site needs at least one host admin.');

  await query(
    `UPDATE users SET
       name = coalesce($2, name),
       site_role = CASE WHEN $3::boolean IS NULL THEN site_role WHEN $3 THEN 'admin' ELSE 'user' END,
       disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN coalesce(disabled_at, now()) ELSE NULL END
     WHERE id = $1`,
    [id, input.name ?? null, input.siteAdmin ?? null, input.disabled ?? null],
  );
  if (input.disabled !== undefined) {
    markDisabled(id, input.disabled);
    if (input.disabled) {
      // Tell their tabs why before the connection closes.
      getIO()?.to(userChannel(id)).emit('account:disabled');
      setTimeout(() => disconnect(id), 300);
    }
  }
  // A new role shows up on their next page load; tell open tabs now.
  if (input.siteAdmin !== undefined) getIO()?.to(userChannel(id)).emit('account:changed');
  res.json({ user: adminUser(await one(`${USER_SELECT} WHERE u.id = $1`, [id])) });
});

adminRouter.post('/users/:id/password', async (req, res) => {
  const id = assertUuid(req.params.id, 'person');
  if (id === req.userId) throw badRequest('Change your own password from the account menu.');
  const { password } = z.object({ password: newPassword }).parse(req.body);
  const row = await one('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [id, await bcrypt.hash(password, 10)]);
  if (!row) throw notFound("That person doesn't exist.");
  // Whoever had their account (and forgot the password) is signed out everywhere.
  await endSessions(id);
  disconnect(id);
  res.status(204).end();
});

adminRouter.delete('/users/:id', async (req, res) => {
  const id = assertUuid(req.params.id, 'person');
  if (id === req.userId) throw badRequest("You can't remove your own account here.");
  const target = await one('SELECT site_role, disabled_at FROM users WHERE id = $1', [id]);
  if (!target) throw notFound("That person doesn't exist.");
  if (target.site_role === 'admin' && !target.disabled_at && (await otherActiveAdmins(id)) === 0) {
    throw badRequest('The site needs at least one host admin.');
  }
  // Their rooms go with them; members are told first.
  const { rows: owned } = await query('SELECT id FROM rooms WHERE owner_id = $1', [id]);
  for (const r of owned) await deleteRoom(r.id);
  disconnect(id);
  await query('DELETE FROM users WHERE id = $1', [id]);
  markDisabled(id, false);
  res.status(204).end();
});

// ── Rooms ─────────────────────────────────────────────────────────────

adminRouter.get('/rooms', async (req, res) => {
  const { q, limit, offset } = page(req);
  const { rows } = await query(
    `SELECT r.id, r.name, r.description, r.max_members, r.created_at,
            r.watch -> 'source' ->> 'title' AS watching, r.watch -> 'source' ->> 'kind' AS watch_kind,
            o.id AS owner_id, o.name AS owner_name, o.avatar_hue AS owner_hue,
            (SELECT count(*)::int FROM room_members m WHERE m.room_id = r.id) AS member_count,
            (SELECT count(*)::int FROM room_messages x WHERE x.room_id = r.id AND x.kind = 'text') AS messages,
            (SELECT max(x.created_at) FROM room_messages x WHERE x.room_id = r.id) AS last_activity,
            count(*) OVER () AS total
     FROM rooms r JOIN users o ON o.id = r.owner_id
     WHERE ($1 = '' OR r.name ILIKE $2 OR o.name ILIKE $2)
     ORDER BY last_activity DESC NULLS LAST, r.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [q, like(q)],
  );
  res.json({
    total: Number(rows[0]?.total ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      maxMembers: r.max_members,
      memberCount: r.member_count,
      messages: r.messages,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity,
      owner: { id: r.owner_id, name: r.owner_name, hue: r.owner_hue },
      watching: r.watching,
      live: r.watch_kind === 'device',
      inVoice: voice.participants(r.id).length,
    })),
  });
});

adminRouter.post('/rooms/:id/stop-video', async (req, res) => {
  const id = assertUuid(req.params.id, 'room');
  const previous = await replaceWatch(id, null);
  if (!previous) throw new AppError(409, 'Nothing is playing in this room.');
  await postSystemMessage(id, 'The host stopped the video');
  res.status(204).end();
});

adminRouter.delete('/rooms/:id', async (req, res) => {
  const id = assertUuid(req.params.id, 'room');
  if (!(await one('SELECT id FROM rooms WHERE id = $1', [id]))) throw notFound("That room doesn't exist.");
  await deleteRoom(id);
  res.status(204).end();
});

// ── Settings ──────────────────────────────────────────────────────────

adminRouter.get('/settings', (_req, res) => res.json({ settings: getSettings() }));

adminRouter.patch('/settings', async (req, res) => {
  const input = z
    .object({
      allowSignups: z.boolean().optional(),
      announcement: z.string().max(280, 'Keep the announcement under 280 characters.').nullable().optional(),
    })
    .parse(req.body);
  res.json({ settings: await saveSettings(input) });
});
