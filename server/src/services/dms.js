import { receiptsShared } from './privacy.js';

export function dmMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    body: row.body,
    meta: row.meta ?? null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    readAt: row.read_at,
    deletedAt: row.deleted_at ?? null,
    replyToId: row.reply_to_id ?? null,
    clientId: row.client_id ?? null,
    editedAt: row.edited_at ?? null,
    forwarded: !!row.forwarded,
    preview: row.preview ?? null,
    attachment: null,
    replyTo: null,
    reactions: [],
  };
}

/** A message as `viewerId` sees it: the read time of their own messages only if both share read receipts. */
export function dmForViewer(message, viewerId) {
  if (message && message.senderId === viewerId && message.readAt && !receiptsShared(message.senderId, message.recipientId)) {
    return { ...message, readAt: null };
  }
  return message;
}

export const DM_COLUMNS = 'id, sender_id, recipient_id, kind, body, meta, created_at, delivered_at, read_at, reply_to_id, deleted_at, client_id, edited_at, forwarded, preview';
