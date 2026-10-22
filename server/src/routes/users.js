import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { one } from '../db.js';
import { AppError, assertUuid, badRequest, forbidden, notFound } from '../errors.js';
import { block, blockedBy, unblock } from '../services/blocks.js';
import { findUser, normalizeHandle, photoUrl, publicUser, USER_COLUMNS } from '../services/users.js';
import { photoFile } from '../services/photos.js';

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

// ── Blocking ──────────────────────────────────────────────────────────
// Blocked people can't message or call me, add me to rooms or invite me, and
// neither of us sees the other's online status. See services/blocks.js.

usersRouter.get('/blocked', async (req, res) => {
  const rows = await blockedBy(req.userId);
  res.json({
    blocked: rows.map((r) => ({ id: r.id, name: r.name, handle: r.handle, hue: r.avatar_hue, photo: photoUrl(r.id, r.photo), blockedAt: r.created_at })),
  });
});

usersRouter.post('/:id/block', async (req, res) => {
  const id = assertUuid(req.params.id, 'person');
  if (id === req.userId) throw badRequest("You can't block yourself.");
  const target = await one('SELECT site_role FROM users WHERE id = $1', [id]);
  if (!target) throw notFound("That person doesn't exist.");
  if (target.site_role === 'admin') throw forbidden("You can't block the site's host.");
  await block(req.userId, id);
  res.json({ blocked: true });
});

usersRouter.delete('/:id/block', async (req, res) => {
  await unblock(req.userId, assertUuid(req.params.id, 'person'));
  res.json({ blocked: false });
});

// A person whose id you already have (from a chat, a room, or finding them).
// Ids are random and never listed anywhere, so this can't be used to browse people.
// A profile photo, for signed-in people. Each version has its own address, so it's cached for good.
usersRouter.get('/:id/photo/:version', async (req, res) => {
  const version = String(req.params.version);
  if (!/^[0-9a-f]{16}$/.test(version)) throw notFound('That photo has changed.');
  const file = await photoFile(assertUuid(req.params.id, 'person'), version);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(file);
});

usersRouter.get('/:id', async (req, res) => {
  const user = await findUser(assertUuid(req.params.id, 'person'), req.userId);
  if (!user) throw notFound("That person doesn't exist.");
  res.json({ user });
});
