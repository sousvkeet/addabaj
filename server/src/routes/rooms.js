import express, { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, query, transaction } from '../db.js';
import { limits } from '../config.js';
import { AppError, assertUuid, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';
import { announceRoomChanged, attachMember, detachMember, inviteForInvitee, listRooms, lockSeat, normalizeRoomCode, postSystemMessage, renewRoomCode, requireAdmin, requireMember, requireRoomAdmin, roomDetail, roomMessage, ROOM_MESSAGE_SELECT, deleteRoom } from '../services/rooms.js';
import { clearAfterText, clearRoomHistory, sweepHistory, UNITS } from '../services/history.js';
import { voice } from '../socket/voice.js';
import { findUser, publicUser, roomPhotoUrl } from '../services/users.js';
import { MAX_PHOTO_BYTES, removeRoomPhoto, roomPhotoFile, saveRoomPhoto } from '../services/photos.js';
import { enrich } from '../services/messages.js';
import { asId, readRoom, sendRoomMessage } from '../services/chat.js';
import { hasBlocked } from '../services/blocks.js';
import { setRoomSettings } from '../services/chatSettings.js';
import { rateLimiter } from '../socket/util.js';

// Plenty for anyone, but no floods: 10 new rooms per 10 minutes per person.
const canCreate = rateLimiter(10, 10 * 60_000);

export const roomsRouter = Router();

const maxMembers = z.coerce
  .number()
  .int('Member limit must be a whole number.')
  .min(limits.minRoomMembers, `A room needs room for at least ${limits.minRoomMembers} people.`)
  .max(limits.maxRoomMembers, `Rooms can hold up to ${limits.maxRoomMembers} people.`);

/** A room password; empty or missing means anyone with the code can join. */
const roomPassword = z
  .string()
  .max(64, 'Keep the room password under 64 characters.')
  .refine((p) => p === '' || p.length >= 4, 'Use at least 4 characters for the room password.');

const roomFields = {
  name: z.string().trim().min(1, 'Give the room a name.').max(60, 'Keep the name under 60 characters.'),
  description: z.string().trim().max(280, 'Keep the description under 280 characters.').default(''),
  maxMembers,
};
const createSchema = z.object({ ...roomFields, password: roomPassword.optional() });
const updateSchema = z.object(roomFields).partial();

const userIdSchema = z.object({ userId: z.string() });

async function me(req) {
  const user = await findUser(req.userId);
  if (!user) throw forbidden();
  return user;
}

roomsRouter.get('/', async (req, res) => {
  res.json({ rooms: await listRooms(req.userId) });
});

roomsRouter.post('/', async (req, res) => {
  const input = createSchema.parse(req.body);
  if (!canCreate(req.userId)) throw new AppError(429, 'That’s a lot of new rooms. Wait a few minutes and try again.');
  const user = await me(req);
  const room = await transaction(async (c) => {
    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
    const { rows: [r] } = await c.query(
      `INSERT INTO rooms (name, description, owner_id, max_members, join_password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.name, input.description, req.userId, input.maxMembers, passwordHash],
    );
    await renewRoomCode(r.id, c);
    await c.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`, [r.id, req.userId]);
    return r;
  });
  await postSystemMessage(room.id, `${user.name} started the room`);
  await attachMember(room.id, req.userId);
  res.status(201).json({ room: await roomDetail(room.id, req.userId) });
});

// ── Joining with an invite code ───────────────────────────────────────

// Looking codes up, and failed tries to join (wrong code, wrong password), are
// limited per person, so codes and passwords can't be guessed.
const codeLookups = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  keyGenerator: (req) => req.userId,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many tries. Wait a few minutes and try again.' },
});
const failedJoins = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.userId,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many wrong tries. Wait 15 minutes and try again.' },
});

async function roomByCode(value) {
  const code = normalizeRoomCode(value);
  if (!code) throw badRequest('Room codes are 8 letters and numbers, like K7PQ-2XMB.');
  const room = await one(
    `SELECT id, name, description, photo, max_members, join_password_hash,
       (SELECT count(*)::int FROM room_members m WHERE m.room_id = rooms.id) AS member_count
     FROM rooms WHERE join_code = $1`,
    [code],
  );
  if (!room) throw notFound('No room has that code. Check it, or ask the room for a new one.');
  return room;
}

// What the code opens, before joining: the room's name and whether it needs a password.
roomsRouter.get('/join/:code', codeLookups, async (req, res) => {
  const room = await roomByCode(req.params.code);
  const member = await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [room.id, req.userId]);
  res.json({
    room: {
      id: room.id,
      name: room.name,
      description: room.description,
      photo: roomPhotoUrl(room.id, room.photo),
      memberCount: room.member_count,
      maxMembers: room.max_members,
      needsPassword: !!room.join_password_hash,
      member: !!member,
    },
  });
});

roomsRouter.post('/join', codeLookups, failedJoins, async (req, res) => {
  const room = await roomByCode(req.body?.code);
  if (await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [room.id, req.userId])) {
    return res.json({ room: await roomDetail(room.id, req.userId) });
  }
  if (room.join_password_hash) {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) throw new AppError(403, 'This room has a password. Enter it to join.');
    if (!(await bcrypt.compare(password.slice(0, 64), room.join_password_hash))) throw new AppError(403, "That password isn't right.");
  }
  const user = await me(req);
  const cancelled = await transaction(async (c) => {
    try {
      // Joined meanwhile (the same tap twice): nothing more to do.
      if ((await lockSeat(c, room.id, req.userId)).member) return null;
    } catch (err) {
      if (err.status === 409) throw conflict(`${room.name} is full. Ask one of its admins to make room.`);
      throw err;
    }
    await c.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [room.id, req.userId]);
    const { rows } = await c.query(
      `UPDATE room_invites SET status = 'accepted', responded_at = now()
       WHERE room_id = $1 AND invitee_id = $2 AND status = 'pending' RETURNING id`,
      [room.id, req.userId],
    );
    return rows;
  });
  if (!cancelled) return res.json({ room: await roomDetail(room.id, req.userId) });
  for (const inv of cancelled) getIO()?.to(userChannel(req.userId)).emit('invite:removed', { inviteId: inv.id });
  await attachMember(room.id, req.userId);
  await postSystemMessage(room.id, `${user.name} joined with the invite code`);
  announceRoomChanged(room.id);
  res.status(201).json({ room: await roomDetail(room.id, req.userId) });
});

// Admins: who can join with the code (open, or with a password).
roomsRouter.patch('/:id/access', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const { password } = z.object({ password: roomPassword.nullable() }).parse(req.body);
  await query('UPDATE rooms SET join_password_hash = $2 WHERE id = $1', [roomId, password ? await bcrypt.hash(password, 10) : null]);
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// Admins: a new code; the old one stops working (for a code that got around).
roomsRouter.post('/:id/code', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  await renewRoomCode(roomId);
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

roomsRouter.get('/:id', async (req, res) => {
  await requireMember(req.params.id, req.userId);
  res.json({ room: await roomDetail(req.params.id, req.userId) });
});

roomsRouter.patch('/:id', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const input = updateSchema.parse(req.body);
  const user = await me(req);
  const before = await transaction(async (c) => {
    const { rows: [room] } = await c.query('SELECT name, max_members FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (input.maxMembers !== undefined) {
      const { rows: [{ count }] } = await c.query(
        'SELECT count(*)::int AS count FROM room_members WHERE room_id = $1', [roomId],
      );
      if (input.maxMembers < count) {
        throw conflict(`This room already has ${count} members. Remove some before lowering the limit to ${input.maxMembers}.`);
      }
    }
    await c.query(
      `UPDATE rooms SET name = COALESCE($2, name), description = COALESCE($3, description),
              max_members = COALESCE($4, max_members) WHERE id = $1`,
      [roomId, input.name ?? null, input.description ?? null, input.maxMembers ?? null],
    );
    return room;
  });
  if (input.name && input.name !== before.name) {
    await postSystemMessage(roomId, `${user.name} renamed the room to “${input.name}”`);
  }
  if (input.maxMembers && input.maxMembers !== before.max_members) {
    await postSystemMessage(roomId, `${user.name} set the member limit to ${input.maxMembers}`);
  }
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// ── Chat history (Room settings): cleared on a schedule, or all at once ──

const historySchema = z.object({
  clearAfter: z
    .object({ amount: z.coerce.number().int().min(1), unit: z.enum(['minute', 'hour', 'day', 'month']) })
    .nullable()
    .superRefine((c, ctx) => {
      if (c && c.amount > UNITS[c.unit]) ctx.addIssue({ code: 'custom', message: `That’s too long: up to ${UNITS[c.unit]} ${c.unit}s.` });
    }),
});

// Messages older than this go by themselves, for everyone (null: kept).
roomsRouter.put('/:id/history', async (req, res) => {
  const roomId = req.params.id;
  await requireRoomAdmin(roomId, req.userId);
  const text = clearAfterText(historySchema.parse(req.body).clearAfter);
  const { clear_after: before } = await one('SELECT clear_after FROM rooms WHERE id = $1', [roomId]);
  if ((before ?? null) !== text) {
    await query('UPDATE rooms SET clear_after = $2 WHERE id = $1', [roomId, text]);
    const user = await me(req);
    await postSystemMessage(roomId, text ? `${user.name} set messages to clear after ${text}` : `${user.name} turned off clearing messages`);
    if (text) await sweepHistory(roomId);
    announceRoomChanged(roomId);
  }
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// Every message goes now, for everyone.
roomsRouter.post('/:id/history/clear', async (req, res) => {
  const roomId = req.params.id;
  await requireRoomAdmin(roomId, req.userId);
  const user = await me(req);
  await clearRoomHistory(roomId);
  await postSystemMessage(roomId, `${user.name} cleared the chat history`);
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// ── Voice, kept in order by the room's admins ─────────────────────────

const moderationSchema = z
  .object({ voiceMuted: z.boolean().optional(), cameraBlocked: z.boolean().optional() })
  .refine((v) => v.voiceMuted !== undefined || v.cameraBlocked !== undefined, { message: 'Nothing to change.' });

/**
 * Muted by an admin: they can't unmute. Camera stopped: they can't turn it on.
 * Until an admin lets them, in voice now or later. Room admins can do it to
 * members; its starter (or the site's host) to admins too; only the host to its starter.
 */
roomsRouter.put('/:id/members/:userId/voice', async (req, res) => {
  const roomId = req.params.id;
  const targetId = String(req.params.userId);
  assertUuid(targetId, 'user');
  const mine = await requireRoomAdmin(roomId, req.userId);
  if (targetId === req.userId) throw badRequest('You can’t do that to yourself.');
  const target = await one('SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
  if (!target) throw notFound('They’re not in this room any more.');
  if (targetId === mine.ownerId && !mine.host) throw forbidden('Nobody can do that to the person who started the room.');
  if (target.role === 'admin' && req.userId !== mine.ownerId && !mine.host) throw forbidden('Only the person who started the room can do that to another admin.');
  const input = moderationSchema.parse(req.body);
  const row = await one(
    `UPDATE room_members SET voice_muted = coalesce($3, voice_muted), camera_blocked = coalesce($4, camera_blocked)
     WHERE room_id = $1 AND user_id = $2 RETURNING voice_muted, camera_blocked`,
    [roomId, targetId, input.voiceMuted ?? null, input.cameraBlocked ?? null],
  );
  const state = { voiceMuted: row.voice_muted, cameraBlocked: row.camera_blocked };
  voice.moderate(roomId, targetId, state);
  // They hear it on every device (the one in voice mutes, or stops its camera).
  getIO()?.to(userChannel(targetId)).emit('voice:moderated', { roomId, ...state });
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// ── Room photo (its admins choose it; members see it in the list, the header and notifications) ──

// For anyone signed in: invitations and invite-code previews show it before joining.
roomsRouter.get('/:id/photo/:version', async (req, res) => {
  const version = String(req.params.version);
  if (!/^[0-9a-f]{16}$/.test(version)) throw notFound('That photo has changed.');
  const file = await roomPhotoFile(assertUuid(req.params.id, 'room'), version);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(file);
});

const roomAdminsOnly = async (req, _res, next) => {
  await requireAdmin(req.params.id, req.userId);
  next();
};

roomsRouter.put('/:id/photo', roomAdminsOnly, express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }), async (req, res) => {
  const roomId = req.params.id;
  const user = await me(req);
  await saveRoomPhoto(roomId, Buffer.isBuffer(req.body) ? req.body : null);
  await postSystemMessage(roomId, `${user.name} changed the room photo`);
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

roomsRouter.delete('/:id/photo', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const user = await me(req);
  if (await removeRoomPhoto(roomId)) {
    await postSystemMessage(roomId, `${user.name} removed the room photo`);
    announceRoomChanged(roomId);
  }
  res.json({ room: await roomDetail(roomId, req.userId) });
});

roomsRouter.delete('/:id', async (req, res) => {
  const roomId = req.params.id;
  const { ownerId } = await requireMember(roomId, req.userId);
  if (ownerId !== req.userId) throw forbidden('Only the person who started the room can delete it.');
  await deleteRoom(roomId);
  res.status(204).end();
});

roomsRouter.get('/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  await requireMember(roomId, req.userId);
  const before = asId(req.query.before);
  const limit = 50;
  const { rows } = await query(
    `${ROOM_MESSAGE_SELECT}
     WHERE m.room_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
       AND NOT EXISTS (SELECT 1 FROM room_hidden h WHERE h.user_id = $4 AND h.message_id = m.id)
       -- Nothing from before the history was cleared, or past its schedule (between sweeps).
       AND m.created_at > coalesce((SELECT greatest(r.history_cleared_at, now() - r.clear_after::interval) FROM rooms r WHERE r.id = $1), '-infinity')
     ORDER BY m.id DESC LIMIT $3`,
    [roomId, before, limit + 1, req.userId],
  );
  res.json({ messages: await enrich('room', rows.slice(0, limit).reverse().map(roomMessage)), hasMore: rows.length > limit });
});

// "Message info" for your own message: who in the room has it and who has seen it.
roomsRouter.get('/:id/messages/:messageId/info', async (req, res) => {
  const roomId = req.params.id;
  await requireMember(roomId, req.userId);
  const messageId = Number(req.params.messageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw notFound("That message doesn't exist.");
  const message = await one('SELECT sender_id FROM room_messages WHERE id = $1 AND room_id = $2', [messageId, roomId]);
  if (!message) throw notFound("That message doesn't exist.");
  if (message.sender_id !== req.userId) throw forbidden('You can only see who read your own messages.');
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.avatar_hue, u.photo, u.last_seen_at, rm.last_read_id, rm.last_delivered_id, rm.last_read_at
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1 AND rm.user_id <> $2
     ORDER BY lower(u.name)`,
    [roomId, req.userId],
  );
  res.json({
    members: rows.map((r) => ({
      user: publicUser(r, req.userId),
      read: Number(r.last_read_id) >= messageId,
      delivered: Math.max(Number(r.last_delivered_id), Number(r.last_read_id)) >= messageId,
    })),
  });
});

// Admin adds someone straight into the room.
roomsRouter.post('/:id/members', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const targetId = assertUuid(userIdSchema.parse(req.body).userId, 'person');
  const [actor, target] = await Promise.all([me(req), findUser(targetId)]);
  if (!target) throw notFound("That person doesn't exist.");
  // They blocked me: I can't put them anywhere.
  if (hasBlocked(targetId, req.userId)) throw forbidden("You can't add this person.");
  const cancelled = await transaction(async (c) => {
    if ((await lockSeat(c, roomId, targetId)).member) throw conflict(`${target.name} is already in this room.`);
    await c.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, targetId]);
    const { rows } = await c.query(
      `UPDATE room_invites SET status = 'cancelled', responded_at = now()
       WHERE room_id = $1 AND invitee_id = $2 AND status = 'pending' RETURNING id`,
      [roomId, targetId],
    );
    return rows;
  });
  for (const inv of cancelled) getIO()?.to(userChannel(targetId)).emit('invite:removed', { inviteId: inv.id });
  await attachMember(roomId, targetId);
  await postSystemMessage(roomId, `${actor.name} added ${target.name}`);
  announceRoomChanged(roomId);
  res.status(201).json({ room: await roomDetail(roomId, req.userId) });
});

// Remove someone (admin) or leave (yourself).
roomsRouter.delete('/:id/members/:userId', async (req, res) => {
  const roomId = req.params.id;
  const targetId = assertUuid(req.params.userId, 'person');
  const actorMembership = await requireMember(roomId, req.userId);
  const leaving = targetId === req.userId;
  if (leaving && actorMembership.ownerId === req.userId) {
    throw badRequest("You started this room, so you can't leave it. Delete the room instead.");
  }
  if (!leaving) {
    if (actorMembership.role !== 'admin') throw forbidden('Only room admins can remove people.');
    if (targetId === actorMembership.ownerId) throw forbidden("The person who started the room can't be removed.");
  }
  const target = await one(
    `SELECT rm.role, u.name FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = $1 AND rm.user_id = $2`,
    [roomId, targetId],
  );
  if (!target) throw notFound("That person isn't in this room.");
  if (!leaving && target.role === 'admin' && actorMembership.ownerId !== req.userId) {
    throw forbidden('Only the person who started the room can remove another admin.');
  }
  await query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, targetId]);
  detachMember(roomId, targetId, leaving ? 'left' : 'removed');
  const actor = await me(req);
  await postSystemMessage(roomId, leaving ? `${target.name} left` : `${actor.name} removed ${target.name}`);
  announceRoomChanged(roomId);
  res.status(204).end();
});

// Owner promotes/demotes admins.
roomsRouter.patch('/:id/members/:userId', async (req, res) => {
  const roomId = req.params.id;
  const targetId = assertUuid(req.params.userId, 'person');
  const { ownerId } = await requireMember(roomId, req.userId);
  if (ownerId !== req.userId) throw forbidden('Only the person who started the room can change admins.');
  if (targetId === ownerId) throw badRequest('You are always an admin of your own room.');
  const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);
  const updated = await one(
    `UPDATE room_members rm SET role = $3 FROM users u
     WHERE rm.room_id = $1 AND rm.user_id = $2 AND u.id = rm.user_id RETURNING u.name`,
    [roomId, targetId, role],
  );
  if (!updated) throw notFound("That person isn't in this room.");
  const actor = await me(req);
  await postSystemMessage(
    roomId,
    role === 'admin' ? `${actor.name} made ${updated.name} an admin` : `${updated.name} is no longer an admin`,
  );
  announceRoomChanged(roomId);
  res.json({ room: await roomDetail(roomId, req.userId) });
});

// Admin invites someone; they accept or decline from their invites list.
roomsRouter.post('/:id/invites', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const targetId = assertUuid(userIdSchema.parse(req.body).userId, 'person');
  const target = await findUser(targetId);
  if (!target) throw notFound("That person doesn't exist.");
  if (hasBlocked(targetId, req.userId)) throw forbidden("You can't invite this person.");
  const room = await one(
    `SELECT r.name, r.max_members, (SELECT count(*)::int FROM room_members m WHERE m.room_id = r.id) AS count,
            EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.user_id = $2) AS is_member
     FROM rooms r WHERE r.id = $1`,
    [roomId, targetId],
  );
  if (room.is_member) throw conflict(`${target.name} is already in this room.`);
  if (room.count >= room.max_members) {
    throw conflict(`${room.name} is full. Raise the member limit or remove someone before inviting.`);
  }
  let invite;
  try {
    invite = await one(
      `INSERT INTO room_invites (room_id, invitee_id, inviter_id) VALUES ($1, $2, $3) RETURNING id`,
      [roomId, targetId, req.userId],
    );
  } catch (err) {
    if (err.code === '23505') throw conflict(`${target.name} already has an invite to this room.`);
    throw err;
  }
  getIO()?.to(userChannel(targetId)).emit('invite:new', await inviteForInvitee(invite.id));
  announceRoomChanged(roomId);
  res.status(201).json({ room: await roomDetail(roomId, req.userId) });
});

roomsRouter.delete('/:id/invites/:inviteId', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const inviteId = assertUuid(req.params.inviteId, 'invite');
  const inv = await one(
    `UPDATE room_invites SET status = 'cancelled', responded_at = now()
     WHERE id = $1 AND room_id = $2 AND status = 'pending' RETURNING invitee_id`,
    [inviteId, roomId],
  );
  if (!inv) throw notFound('That invite was already answered or cancelled.');
  getIO()?.to(userChannel(inv.invitee_id)).emit('invite:removed', { inviteId });
  announceRoomChanged(roomId);
  res.status(204).end();
});


// Replying from a notification on the phone.
roomsRouter.post('/:id/messages', async (req, res) => {
  const roomId = assertUuid(req.params.id, 'room');
  const message = await sendRoomMessage(await me(req), roomId, { body: req.body?.body, replyTo: req.body?.replyTo });
  res.status(201).json({ message });
});

// My notifications for a room: off for 8 hours, a week, or until I turn them
// back on. Messages that mention me or reply to me still come through.
const MUTE_UNTIL = { '8h': `now() + interval '8 hours'`, '1w': `now() + interval '7 days'`, always: `'9999-12-31T00:00:00Z'::timestamptz`, off: 'NULL' };

roomsRouter.put('/:id/mute', async (req, res) => {
  const roomId = assertUuid(req.params.id, 'room');
  const { for: span } = z.object({ for: z.enum(['8h', '1w', 'always', 'off'], 'Choose how long to mute it for.') }).parse(req.body);
  const row = await one(
    `UPDATE room_members SET muted_until = ${MUTE_UNTIL[span]} WHERE room_id = $1 AND user_id = $2
     RETURNING CASE WHEN muted_until > now() THEN muted_until END AS muted_until`,
    [roomId, req.userId],
  );
  if (!row) throw notFound("That room doesn't exist or you're not a member.");
  // My other devices show it too.
  getIO()?.to(userChannel(req.userId)).emit('room:muted', { roomId, mutedUntil: row.muted_until });
  res.json({ mutedUntil: row.muted_until });
});

// Pin a room to the top of my list, or archive it: { pinned?, archived? }.
roomsRouter.put('/:id/settings', async (req, res) => {
  const roomId = assertUuid(req.params.id, 'room');
  const change = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional() }).parse(req.body);
  res.json(await setRoomSettings(req.userId, roomId, change));
});

// "Mark as read" from a notification: everything in the room so far.
roomsRouter.post('/:id/read', async (req, res) => {
  const roomId = assertUuid(req.params.id, 'room');
  await requireMember(roomId, req.userId);
  await readRoom(req.userId, roomId);
  res.status(204).end();
});
