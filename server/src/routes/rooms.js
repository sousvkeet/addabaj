import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db.js';
import { limits } from '../config.js';
import { assertUuid, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';
import {
  announceRoomChanged, attachMember, detachMember, inviteForInvitee, listRooms, lockSeat,
  postSystemMessage, requireAdmin, requireMember, roomDetail, roomMessage, ROOM_MESSAGE_SELECT,
} from '../services/rooms.js';
import { findUser } from '../services/users.js';

export const roomsRouter = Router();

const maxMembers = z.coerce
  .number()
  .int('Member limit must be a whole number.')
  .min(limits.minRoomMembers, `A room needs room for at least ${limits.minRoomMembers} people.`)
  .max(limits.maxRoomMembers, `Rooms can hold up to ${limits.maxRoomMembers} people.`);

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the room a name.').max(60, 'Keep the name under 60 characters.'),
  description: z.string().trim().max(280, 'Keep the description under 280 characters.').default(''),
  maxMembers,
});

const updateSchema = createSchema.partial();

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
  const user = await me(req);
  const room = await transaction(async (c) => {
    const { rows: [r] } = await c.query(
      `INSERT INTO rooms (name, description, owner_id, max_members) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.name, input.description, req.userId, input.maxMembers],
    );
    await c.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin')`, [r.id, req.userId]);
    return r;
  });
  await postSystemMessage(room.id, `${user.name} started the room`);
  await attachMember(room.id, req.userId);
  res.status(201).json({ room: await roomDetail(room.id, req.userId) });
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

roomsRouter.delete('/:id', async (req, res) => {
  const roomId = req.params.id;
  const { ownerId } = await requireMember(roomId, req.userId);
  if (ownerId !== req.userId) throw forbidden('Only the person who started the room can delete it.');
  const { rows: members } = await query('SELECT user_id FROM room_members WHERE room_id = $1', [roomId]);
  const { rows: invites } = await query(
    `SELECT id, invitee_id FROM room_invites WHERE room_id = $1 AND status = 'pending'`, [roomId],
  );
  await query('DELETE FROM rooms WHERE id = $1', [roomId]);
  for (const m of members) detachMember(roomId, m.user_id, 'deleted');
  for (const i of invites) getIO()?.to(userChannel(i.invitee_id)).emit('invite:removed', { inviteId: i.id });
  res.status(204).end();
});

roomsRouter.get('/:id/messages', async (req, res) => {
  const roomId = req.params.id;
  await requireMember(roomId, req.userId);
  const before = Number(req.query.before) || null;
  const limit = 50;
  const { rows } = await query(
    `${ROOM_MESSAGE_SELECT}
     WHERE m.room_id = $1 AND ($2::bigint IS NULL OR m.id < $2)
     ORDER BY m.id DESC LIMIT $3`,
    [roomId, before, limit + 1],
  );
  res.json({ messages: rows.slice(0, limit).reverse().map(roomMessage), hasMore: rows.length > limit });
});

// Admin adds someone straight into the room.
roomsRouter.post('/:id/members', async (req, res) => {
  const roomId = req.params.id;
  await requireAdmin(roomId, req.userId);
  const targetId = assertUuid(userIdSchema.parse(req.body).userId, 'person');
  const [actor, target] = await Promise.all([me(req), findUser(targetId)]);
  if (!target) throw notFound("That person doesn't exist.");
  const cancelled = await transaction(async (c) => {
    await lockSeat(c, roomId);
    const { rowCount } = await c.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [roomId, targetId],
    );
    if (!rowCount) throw conflict(`${target.name} is already in this room.`);
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

