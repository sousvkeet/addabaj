import { Router } from 'express';
import { z } from 'zod';
import { AppError, assertUuid } from '../errors.js';
import { DM_COLUMNS, dmForViewer, dmMessage } from '../services/dms.js';
import { enrich } from '../services/messages.js';
import { publicUser } from '../services/users.js';
import { asId, readDm, sendDm } from '../services/chat.js';
import { MUTE_SPANS, setDmSettings, settingsOf } from '../services/chatSettings.js';
import { clearDmHistory } from '../services/history.js';
import { one, query } from '../db.js';

export const dmsRouter = Router();

// One row per person you've talked with: latest message, unread count, and my
// settings for the chat (muted, pinned, archived). A chat I cleared (or that
// was cleared for me) stays, empty, until the next message: clearedAt.
dmsRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (partner) partner, ${DM_COLUMNS}
       FROM (
         SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS partner, *
         FROM dm_messages d WHERE (sender_id = $1 OR recipient_id = $1)
           AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = $1 AND h.message_id = d.id)
       ) m
       ORDER BY partner, id DESC
     )
     SELECT l.*, u.email, u.handle, u.name, u.avatar_hue, u.photo, u.last_seen_at,
       s.muted_until, s.pinned_at, s.archived_at, s.cleared_at,
       (SELECT count(*)::int FROM dm_messages d
         WHERE d.recipient_id = $1 AND d.sender_id = l.partner AND d.read_at IS NULL AND d.deleted_at IS NULL AND d.kind = 'text'
           AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = $1 AND h.message_id = d.id)) AS unread
     FROM latest l JOIN users u ON u.id = l.partner
     LEFT JOIN dm_settings s ON s.user_id = $1 AND s.peer_id = l.partner
     ORDER BY l.id DESC`,
    [req.userId],
  );
  const conversations = rows.map((r) => ({
      partner: publicUser({ id: r.partner, email: r.email, handle: r.handle, name: r.name, avatar_hue: r.avatar_hue, photo: r.photo, last_seen_at: r.last_seen_at }, req.userId),
      lastMessage: dmForViewer(dmMessage(r), req.userId),
      unread: r.unread,
      ...settingsOf(r),
      clearedAt: r.cleared_at ?? null,
    }));
  await enrich('dm', conversations.map((c) => c.lastMessage));
  // Cleared chats with nothing in them since.
  const { rows: empty } = await query(
    `SELECT s.peer_id, s.muted_until, s.pinned_at, s.archived_at, s.cleared_at, u.email, u.handle, u.name, u.avatar_hue, u.photo, u.last_seen_at
     FROM dm_settings s JOIN users u ON u.id = s.peer_id
     WHERE s.user_id = $1 AND s.cleared_at IS NOT NULL AND NOT (s.peer_id = ANY($2::uuid[]))`,
    [req.userId, rows.map((r) => r.partner)],
  );
  for (const r of empty) {
    conversations.push({
      partner: publicUser({ id: r.peer_id, email: r.email, handle: r.handle, name: r.name, avatar_hue: r.avatar_hue, photo: r.photo, last_seen_at: r.last_seen_at }, req.userId),
      lastMessage: null,
      unread: 0,
      ...settingsOf(r),
      clearedAt: r.cleared_at,
    });
  }
  const when = (c) => new Date(c.lastMessage?.createdAt ?? c.clearedAt).getTime();
  conversations.sort((a, b) => when(b) - when(a));
  res.json({ conversations });
});

dmsRouter.get('/:userId/messages', async (req, res) => {
  const partner = assertUuid(req.params.userId, 'person');
  const before = asId(req.query.before);
  const limit = 50;
  const { rows } = await query(
    `SELECT ${DM_COLUMNS} FROM dm_messages
     WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
       AND ($3::bigint IS NULL OR id < $3)
       AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = $1 AND h.message_id = dm_messages.id)
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

// My settings for a chat: { mute?: '8h' | '1w' | 'always' | 'off', pinned?, archived? }.
dmsRouter.put('/:userId/settings', async (req, res) => {
  const peer = assertUuid(req.params.userId, 'person');
  const change = z
    .object({ mute: z.enum(MUTE_SPANS, 'Choose how long to mute it for.').optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() })
    .parse(req.body);
  if (peer === req.userId) throw new AppError(400, "That's you.");
  res.json(await setDmSettings(req.userId, peer, change));
});

// Clear chat history: { everyone?: true } clears it for them too (see clearDmHistory).
dmsRouter.post('/:userId/clear', async (req, res) => {
  const peer = assertUuid(req.params.userId, 'person');
  const { everyone } = z.object({ everyone: z.boolean().optional() }).parse(req.body ?? {});
  if (peer === req.userId) throw new AppError(400, "That's you.");
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [peer]))) throw new AppError(404, "That person doesn't exist.");
  res.json(await clearDmHistory(req.userId, peer, !!everyone));
});

// "Mark as read" from a notification.
dmsRouter.post('/:userId/read', async (req, res) => {
  await readDm(req.userId, assertUuid(req.params.userId, 'person'));
  res.status(204).end();
});
