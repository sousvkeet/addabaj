export function dmMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    body: row.body,
    meta: row.meta ?? null,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export const DM_COLUMNS = 'id, sender_id, recipient_id, kind, body, meta, created_at, read_at';
