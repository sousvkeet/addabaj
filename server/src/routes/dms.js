import { Router } from 'express';
import { query } from '../db.js';
import { assertUuid } from '../errors.js';
import { DM_COLUMNS, dmForViewer, dmMessage } from '../services/dms.js';
import { enrich } from '../services/messages.js';
import { publicUser } from '../services/users.js';
import { readDm, sendDm } from '../services/chat.js';

export const dmsRouter = Router();

// One row per person you've talked with: latest message + unread count.
dmsRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (partner) partner, ${DM_COLUMNS}
       FROM (
         SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS partner, *
         FROM dm_messages WHERE sender_id = $1 OR recipient_id = $1
       ) m
       ORDER BY partner, id DESC
     )
     SELECT l.*, u.email, u.handle, u.name, u.avatar_hue, u.last_seen_at,
       (SELECT count(*)::int FROM dm_messages d
         WHERE d.recipient_id = $1 AND d.sender_id = l.partner AND d.read_at IS NULL) AS unread
     FROM latest l JOIN users u ON u.id = l.partner
     ORDER BY l.id DESC`,
    [req.userId],
  );
  const conversations = rows.map((r) => ({
      partner: publicUser({ id: r.partner, email: r.email, handle: r.handle, name: r.name, avatar_hue: r.avatar_hue, last_seen_at: r.last_seen_at }, req.userId),
      lastMessage: dmForViewer(dmMessage(r), req.userId),
      unread: r.unread,
    }));
  await enrich('dm', conversations.map((c) => c.lastMessage));
  res.json({ conversations });
});

dmsRouter.get('/:userId/messages', async (req, res) => {
  const partner = assertUuid(req.params.userId, 'person');
  const before = Number(req.query.before) || null;
  const limit = 50;
  const { rows } = await query(
    `SELECT ${DM_COLUMNS} FROM dm_messages
     WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
       AND ($3::bigint IS NULL OR id < $3)
     ORDER BY id DESC LIMIT $4`,
    [req.userId, partner, before, limit + 1],
  );
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse().map((r) => dmForViewer(dmMessage(r), req.userId));
  res.json({ messages: await enrich('dm', messages), hasMore });
});

// Replying from a notification on the phone.
dmsRouter.post('/:userId/messages', async (req, res) => {
  const partner = assertUuid(req.params.userId, 'person');
  const message = await sendDm(req.userId, partner, { body: req.body?.body, replyTo: req.body?.replyTo });
  res.status(201).json({ message });
});

// "Mark as read" from a notification.
dmsRouter.post('/:userId/read', async (req, res) => {
  await readDm(req.userId, assertUuid(req.params.userId, 'person'));
  res.status(204).end();
});
