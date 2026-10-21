import { Router } from 'express';
import { query } from '../db.js';
import { assertUuid, notFound } from '../errors.js';
import { findUser, publicUser, USER_COLUMNS } from '../services/users.js';

export const usersRouter = Router();

// Search people by name or email. With ?roomId, each result also says whether
// they're already a member or have a pending invite, for the add/invite picker.
usersRouter.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const roomId = req.query.roomId ? assertUuid(String(req.query.roomId), 'room') : null;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await query(
    `SELECT ${USER_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}
       ${roomId ? `,
       EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = $3 AND m.user_id = u.id) AS is_member,
       EXISTS (SELECT 1 FROM room_invites i WHERE i.room_id = $3 AND i.invitee_id = u.id AND i.status = 'pending') AS is_invited` : ''}
     FROM users u
     WHERE u.id <> $1 AND u.disabled_at IS NULL AND ($2 = '%%' OR u.name ILIKE $2 OR u.email ILIKE $2)
     ORDER BY lower(u.name)
     LIMIT 30`,
    roomId ? [req.userId, pattern, roomId] : [req.userId, pattern],
  );
  res.json({
    users: rows.map((r) => ({
      ...publicUser(r),
      ...(roomId ? { roomStatus: r.is_member ? 'member' : r.is_invited ? 'invited' : null } : {}),
    })),
  });
});

usersRouter.get('/:id', async (req, res) => {
  const user = await findUser(assertUuid(req.params.id, 'person'));
  if (!user) throw notFound("That person doesn't exist.");
  res.json({ user });
});
