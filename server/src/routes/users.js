import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one } from '../db.js';
import { AppError, assertUuid, badRequest, notFound } from '../errors.js';
import { findUser, normalizeHandle, publicUser, USER_COLUMNS } from '../services/users.js';

export const usersRouter = Router();

// There's no list of everyone on Adda Khana. You find a person by their exact
// user ID or email, and only a few times a minute, so nobody can page through
// the members or try email after email.
const lookups = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.userId,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many searches. Wait a few minutes and try again.' },
});

const EMAIL = /^[^\s@]+@[^\s@]+$/;

// One person, by exact user ID or email. With ?roomId, it also says whether
// they're already a member or have a pending invite, for the add/invite dialog.
usersRouter.get('/find', lookups, async (req, res) => {
  const raw = String(req.query.q ?? '').trim();
  if (!raw) throw badRequest('Enter a user ID or an email address.');
  const email = EMAIL.test(raw) ? raw.toLowerCase().slice(0, 254) : null;
  const handle = email ? null : normalizeHandle(raw);
  if (!email && !handle) throw badRequest("That isn't a user ID or an email address. User IDs look like ana.rahman4821.");
  const roomId = req.query.roomId ? assertUuid(String(req.query.roomId), 'room') : null;
  const row = await one(
    `SELECT ${USER_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}
       ${roomId ? `,
       EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = $2 AND m.user_id = u.id) AS is_member,
       EXISTS (SELECT 1 FROM room_invites i WHERE i.room_id = $2 AND i.invitee_id = u.id AND i.status = 'pending') AS is_invited` : ''}
     FROM users u
     WHERE u.disabled_at IS NULL AND ${email ? 'lower(u.email) = $1' : 'lower(u.handle) = $1'}`,
    roomId ? [email ?? handle, roomId] : [email ?? handle],
  );
  if (!row) throw notFound(`No one on Adda Khana has that ${email ? 'email' : 'user ID'}. Check it and try again.`);
  if (row.id === req.userId) throw new AppError(400, "That's you! Ask your friend for their user ID or email.");
  res.json({
    user: {
      ...publicUser(row, req.userId),
      ...(roomId ? { roomStatus: row.is_member ? 'member' : row.is_invited ? 'invited' : null } : {}),
    },
  });
});

// A person whose id you already have (from a chat, a room, or finding them).
// Ids are random and never listed anywhere, so this can't be used to browse people.
usersRouter.get('/:id', async (req, res) => {
  const user = await findUser(assertUuid(req.params.id, 'person'), req.userId);
  if (!user) throw notFound("That person doesn't exist.");
  res.json({ user });
});
