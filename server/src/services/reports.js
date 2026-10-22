// Reports to the host admin: a person, or a message of theirs in a chat or a
// room. A report keeps a copy of what it's about (the message, the ten before
// it, and what the message said before any edit), so the host sees it as it
// was even if it's changed or deleted later. The host admin's side is in
// Admin › Reports (routes/admin.js).
import { one, query } from '../db.js';
import { AppError } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';
import { block } from './blocks.js';
import { asId } from './chat.js';

export const REASONS = ['spam', 'harassment', 'inappropriate', 'impersonation', 'other'];
/** Reports one person can send a day. */
const PER_DAY = 20;
/** Messages kept from before the reported one. */
const BEFORE = 10;

const hostIds = async () => (await query(`SELECT id FROM users WHERE site_role = 'admin' AND disabled_at IS NULL`)).rows.map((r) => r.id);

/** Every host admin's app shows how many reports are waiting. */
export async function tellHosts() {
  const io = getIO();
  if (!io) return;
  const { open } = await one(`SELECT count(*)::int AS open FROM reports WHERE status = 'open'`);
  for (const id of await hostIds()) io.to(userChannel(id)).emit('admin:reports', { open });
}

const kept = (r) => ({
  id: Number(r.id),
  senderId: r.sender_id,
  senderName: r.sender_name ?? null,
  kind: r.kind,
  body: r.body,
  file: r.file_id ? { id: r.file_id, kind: r.file_kind, name: r.file_name } : null,
  createdAt: r.created_at,
  editedAt: r.edited_at ?? null,
  deletedAt: r.deleted_at ?? null,
  forwarded: !!r.forwarded,
});

/** The last messages of my chat with someone, up to `upTo` (all of them: null), as I see them. */
async function dmContext(meId, otherId, upTo) {
  const { rows } = await query(
    `SELECT m.*, u.name AS sender_name, a.id AS file_id, a.kind AS file_kind, a.name AS file_name
     FROM dm_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN attachments a ON a.dm_message_id = m.id
     WHERE ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
       AND ($3::bigint IS NULL OR m.id <= $3)
       AND NOT EXISTS (SELECT 1 FROM dm_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
     ORDER BY m.id DESC LIMIT $4`,
    [meId, otherId, upTo, BEFORE + 1],
  );
  return rows.reverse().map(kept);
}

async function roomContext(meId, roomId, upTo) {
  const { rows } = await query(
    `SELECT m.*, u.name AS sender_name, a.id AS file_id, a.kind AS file_kind, a.name AS file_name
     FROM room_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN attachments a ON a.room_message_id = m.id
     WHERE m.room_id = $2 AND m.id <= $3
       AND NOT EXISTS (SELECT 1 FROM room_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
     ORDER BY m.id DESC LIMIT $4`,
    [meId, roomId, upTo, BEFORE + 1],
  );
  return rows.reverse().map(kept);
}

const editsOf = async (scope, messageId) =>
  (await query('SELECT body, edited_at FROM message_edits WHERE scope = $1 AND message_id = $2 ORDER BY id', [scope, messageId])).rows.map((r) => ({
    body: r.body,
    editedAt: r.edited_at,
  }));

/**
 * Sends a report: { scope: 'user' | 'dm' | 'room', targetId (a person),
 * messageId (a message in my chat with them, or in a room of mine), reason,
 * details, block }. `block`: I block them too.
 */
export async function createReport(reporterId, { scope, targetId, messageId: rawId, reason, details, block: alsoBlock }) {
  const { n } = await one(`SELECT count(*)::int AS n FROM reports WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`, [reporterId]);
  if (n >= PER_DAY) throw new AppError(429, "You've sent a lot of reports today. The host will look at them; you can send more tomorrow.");
  const messageId = rawId == null ? null : asId(rawId);
  if (rawId != null && !messageId) throw new AppError(404, "That message doesn't exist.");
  let roomId = null;
  let snapshot;
  if (scope === 'user') {
    if (!targetId) throw new AppError(400, 'Choose who to report.');
    snapshot = { messages: await dmContext(reporterId, targetId, null) };
  } else if (scope === 'dm') {
    const m = messageId && (await one('SELECT sender_id, recipient_id FROM dm_messages WHERE id = $1', [messageId]));
    if (!m || (m.sender_id !== reporterId && m.recipient_id !== reporterId)) throw new AppError(404, "That message doesn't exist.");
    if (m.sender_id === reporterId) throw new AppError(400, "That's your own message.");
    targetId = m.sender_id;
    snapshot = { messages: await dmContext(reporterId, targetId, messageId), edits: await editsOf('dm', messageId) };
  } else if (scope === 'room') {
    const m =
      messageId &&
      (await one(
        `SELECT m.sender_id, m.room_id, m.kind, r.name FROM room_messages m JOIN rooms r ON r.id = m.room_id
         WHERE m.id = $1 AND EXISTS (SELECT 1 FROM room_members x WHERE x.room_id = m.room_id AND x.user_id = $2)`,
        [messageId, reporterId],
      ));
    if (!m || m.kind !== 'text' || !m.sender_id) throw new AppError(404, "That message doesn't exist.");
    if (m.sender_id === reporterId) throw new AppError(400, "That's your own message.");
    targetId = m.sender_id;
    roomId = m.room_id;
    snapshot = { room: { id: m.room_id, name: m.name }, messages: await roomContext(reporterId, m.room_id, messageId), edits: await editsOf('room', messageId) };
  } else {
    throw new AppError(400, 'Choose what to report.');
  }
  const target = await one('SELECT id, name, handle, email, site_role FROM users WHERE id = $1', [targetId]);
  if (!target || target.id === reporterId) throw new AppError(404, "That person doesn't exist.");
  if (target.site_role === 'admin') throw new AppError(403, "The site's host can't be reported here.");
  snapshot.target = { id: target.id, name: target.name, handle: target.handle, email: target.email };
  const text = details?.trim() || null;
  // The same thing again before the host has looked: still one report, brought up to date.
  const again = await one(
    `UPDATE reports SET reason = $5, details = coalesce($6, details), snapshot = $7, created_at = now()
     WHERE reporter_id = $1 AND target_id = $2 AND scope = $3 AND message_id IS NOT DISTINCT FROM $4 AND status = 'open'
     RETURNING id`,
    [reporterId, targetId, scope, messageId, reason, text, JSON.stringify(snapshot)],
  );
  const report =
    again ??
    (await one(
      `INSERT INTO reports (reporter_id, target_id, scope, room_id, message_id, reason, details, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [reporterId, targetId, scope, roomId, messageId, reason, text, JSON.stringify(snapshot)],
    ));
  if (alsoBlock) await block(reporterId, targetId);
  void tellHosts().catch(() => {});
  return { id: report.id, blocked: !!alsoBlock };
}

// ── The host admin's side ─────────────────────────────────────────────

const view = (r) => ({
  id: r.id,
  scope: r.scope,
  reason: r.reason,
  details: r.details,
  status: r.status,
  // What the host did about it: 'deleted-message', 'switched-off'.
  actions: r.action ? r.action.split(',') : [],
  createdAt: r.created_at,
  handledAt: r.handled_at,
  handledBy: r.handled_by_name ?? null,
  messageId: r.message_id == null ? null : Number(r.message_id),
  room: r.room_id ? { id: r.room_id, name: r.room_name ?? r.snapshot?.room?.name ?? null } : null,
  reporter: r.reporter_id ? { id: r.reporter_id, name: r.reporter_name, handle: r.reporter_handle } : null,
  target: r.target_id
    ? { id: r.target_id, name: r.target_name, handle: r.target_handle, email: r.target_email, disabled: !!r.target_disabled_at, reports: r.target_reports }
    : (r.snapshot?.target ? { ...r.snapshot.target, gone: true } : null),
  messages: r.snapshot?.messages ?? [],
  edits: r.snapshot?.edits ?? [],
  // The reported message as it is now: gone already, or still there.
  messageDeleted: r.message_id == null ? null : !!r.now_deleted,
});

const LIST = `
  SELECT p.*, ru.name AS reporter_name, ru.handle AS reporter_handle,
    tu.name AS target_name, tu.handle AS target_handle, tu.email AS target_email, tu.disabled_at AS target_disabled_at,
    (SELECT count(*)::int FROM reports x WHERE x.target_id = p.target_id) AS target_reports,
    hu.name AS handled_by_name, rr.name AS room_name,
    CASE p.scope
      WHEN 'dm' THEN (SELECT d.deleted_at IS NOT NULL FROM dm_messages d WHERE d.id = p.message_id)
      WHEN 'room' THEN (SELECT m.deleted_at IS NOT NULL FROM room_messages m WHERE m.id = p.message_id)
    END AS now_deleted
  FROM reports p
  LEFT JOIN users ru ON ru.id = p.reporter_id
  LEFT JOIN users tu ON tu.id = p.target_id
  LEFT JOIN users hu ON hu.id = p.handled_by
  LEFT JOIN rooms rr ON rr.id = p.room_id`;

/** Reports, newest first: 'open' (waiting), or 'closed' (resolved or dismissed). */
export async function listReports(status, { limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `${LIST} WHERE ${status === 'open' ? `p.status = 'open'` : `p.status <> 'open'`}
     ORDER BY ${status === 'open' ? 'p.created_at' : 'p.handled_at'} DESC LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  const { open } = await one(`SELECT count(*)::int AS open FROM reports WHERE status = 'open'`);
  return { reports: rows.slice(0, limit).map(view), hasMore: rows.length > limit, open };
}

export async function getReport(id) {
  const row = await one(`${LIST} WHERE p.id = $1`, [id]);
  return row ? view(row) : null;
}

/**
 * Sets where a report stands: 'resolved', 'dismissed', or 'open' again; `did`
 * is what the host just did about it (kept with what they did before).
 */
export async function closeReport(id, adminId, status, did = null) {
  const row = await one(
    `UPDATE reports SET status = $2,
       action = CASE WHEN $3::text IS NULL THEN action WHEN action IS NULL THEN $3 WHEN position($3 IN action) > 0 THEN action ELSE action || ',' || $3 END,
       handled_by = CASE WHEN $2 = 'open' THEN NULL ELSE $4::uuid END,
       handled_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
     WHERE id = $1 RETURNING id`,
    [id, status, did, adminId],
  );
  if (!row) throw new AppError(404, 'That report was removed.');
  void tellHosts().catch(() => {});
  return getReport(id);
}

/** A file in a report's messages, for the host to see (null: it isn't in this report). */
export async function reportFile(reportId, fileId) {
  const r = await one('SELECT snapshot FROM reports WHERE id = $1', [reportId]);
  return (r?.snapshot?.messages ?? []).some((m) => m.file?.id === fileId) ? fileId : null;
}
