import { Router } from 'express';
import { one, query, transaction } from '../db.js';
import { assertUuid, notFound } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';
import {
  announceRoomChanged, attachMember, inviteForInvitee, lockSeat, postSystemMessage, roomDetail,
} from '../services/rooms.js';
import { findUser } from '../services/users.js';

export const invitesRouter = Router();

invitesRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id FROM room_invites WHERE invitee_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [req.userId],
  );
  const invites = await Promise.all(rows.map((r) => inviteForInvitee(r.id)));
  res.json({ invites: invites.filter(Boolean) });
});

async function pendingInvite(inviteId, userId) {
  assertUuid(inviteId, 'invite');
  const inv = await one(
    `SELECT id, room_id FROM room_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`,
    [inviteId, userId],
  );
  if (!inv) throw notFound('That invite was cancelled or already answered.');
  return inv;
}

invitesRouter.post('/:id/accept', async (req, res) => {
  const inv = await pendingInvite(req.params.id, req.userId);
  await transaction(async (c) => {
    await lockSeat(c, inv.room_id);
    await c.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [inv.room_id, req.userId],
    );
    await c.query(`UPDATE room_invites SET status = 'accepted', responded_at = now() WHERE id = $1`, [inv.id]);
  });
  const user = await findUser(req.userId);
  getIO()?.to(userChannel(req.userId)).emit('invite:removed', { inviteId: inv.id });
  await attachMember(inv.room_id, req.userId);
  await postSystemMessage(inv.room_id, `${user.name} joined`);
  announceRoomChanged(inv.room_id);
  res.json({ room: await roomDetail(inv.room_id, req.userId) });
});

invitesRouter.post('/:id/decline', async (req, res) => {
  const inv = await pendingInvite(req.params.id, req.userId);
  await query(`UPDATE room_invites SET status = 'declined', responded_at = now() WHERE id = $1`, [inv.id]);
  getIO()?.to(userChannel(req.userId)).emit('invite:removed', { inviteId: inv.id });
  announceRoomChanged(inv.room_id);
  res.status(204).end();
});
