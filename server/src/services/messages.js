// Everything a message carries besides its text: an attachment (photo, video,
// voice message or file), the message it replies to, and its reactions.
import { query } from '../db.js';
import { publicAttachment } from './uploads.js';

export const SCOPES = {
  dm: { table: 'dm_messages', fk: 'dm_message_id', reactions: 'dm_reactions' },
  room: { table: 'room_messages', fk: 'room_message_id', reactions: 'room_reactions' },
};

function groupReactions(rows) {
  const by = new Map();
  for (const r of rows) {
    const list = by.get(Number(r.message_id)) ?? [];
    list.push({ emoji: r.emoji, users: r.users });
    by.set(Number(r.message_id), list);
  }
  return by;
}

const REACTIONS_SQL = (table) => `
  SELECT message_id, emoji, array_agg(user_id::text ORDER BY created_at) AS users, min(created_at) AS first
  FROM ${table} WHERE message_id = ANY($1::bigint[])
  GROUP BY message_id, emoji ORDER BY first`;

/** Fills in attachment, replyTo and reactions on messages of one scope (in place). */
export async function enrich(scope, messages) {
  const list = messages.filter((m) => m && Number.isSafeInteger(m.id) && m.id > 0);
  if (!list.length) return messages;
  const s = SCOPES[scope];
  const ids = list.map((m) => m.id);
  const replyIds = [...new Set(list.map((m) => m.replyToId).filter(Boolean))];
  const [atts, replies, reactions] = await Promise.all([
    query(`SELECT * FROM attachments WHERE ${s.fk} = ANY($1::bigint[])`, [ids]),
    replyIds.length
      ? query(
          `SELECT m.id, m.body, m.sender_id, m.deleted_at, u.name AS sender_name, a.kind AS a_kind, a.name AS a_name, a.duration AS a_duration
           FROM ${s.table} m
           LEFT JOIN users u ON u.id = m.sender_id
           LEFT JOIN attachments a ON a.${s.fk} = m.id
           WHERE m.id = ANY($1::bigint[])`,
          [replyIds],
        )
      : { rows: [] },
    query(REACTIONS_SQL(s.reactions), [ids]),
  ]);
  const attBy = new Map(atts.rows.map((r) => [Number(r[s.fk]), publicAttachment(r)]));
  const replyBy = new Map(
    replies.rows.map((r) => [
      Number(r.id),
      r.deleted_at ? { id: Number(r.id), deleted: true } : {
        id: Number(r.id),
        senderId: r.sender_id,
        senderName: r.sender_name ?? 'Someone',
        body: (r.body ?? '').slice(0, 200),
        attachment: r.a_kind ? { kind: r.a_kind, name: r.a_name, duration: r.a_duration } : null,
      },
    ]),
  );
  const reactBy = groupReactions(reactions.rows);
  for (const m of list) {
    m.attachment = attBy.get(m.id) ?? null;
    m.replyTo = m.replyToId ? replyBy.get(m.replyToId) ?? { id: m.replyToId, deleted: true } : null;
    m.reactions = reactBy.get(m.id) ?? [];
  }
  return messages;
}

/** Current reactions on one message. */
export async function reactionsFor(scope, messageId) {
  const { rows } = await query(REACTIONS_SQL(SCOPES[scope].reactions), [[messageId]]);
  return groupReactions(rows).get(messageId) ?? [];
}

/** Adds the reaction if it isn't there yet, otherwise removes it. */
export async function toggleReaction(scope, messageId, userId, emoji) {
  const table = SCOPES[scope].reactions;
  const removed = await query(`DELETE FROM ${table} WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [messageId, userId, emoji]);
  if (!removed.rowCount) {
    await query(`INSERT INTO ${table} (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [messageId, userId, emoji]);
  }
  return reactionsFor(scope, messageId);
}
