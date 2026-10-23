// Photos, videos, voice messages and files sent in chats and rooms. Files
// live on the server's disk under random names; the database knows who sent
// them and in which chat or room, which decides who may open them.
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { copyFile, open, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { rootDir } from '../config.js';
import { one, query } from '../db.js';
import { AppError, assertUuid, notFound } from '../errors.js';

export const uploadDir = process.env.UPLOAD_DIR || resolve(rootDir, 'server/uploads');
export const maxUploadBytes = Math.max(1, Number(process.env.UPLOAD_MAX_MB ?? 25) || 25) * 1024 * 1024;
mkdirSync(uploadDir, { recursive: true });
/** Small copies of photos and video frames, for chat bubbles (services/thumbs.js). */
export const thumbDir = join(uploadDir, '.thumbs');
mkdirSync(thumbDir, { recursive: true });

/** What a file really is, from its first bytes (never trust the name or the browser's guess). */
function sniff(head) {
  const ascii = (a, b) => head.toString('latin1', a, b);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return { kind: 'image', mime: 'image/png' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (head.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'av', mime: 'webm' }; // WebM/Matroska (audio or video)
  if (ascii(4, 8) === 'ftyp') return { kind: 'av', mime: 'mp4' }; // MP4/M4A/MOV family
  if (ascii(0, 4) === 'OggS') return { kind: 'av', mime: 'ogg' };
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return { kind: 'av', mime: 'mpeg' };
  return null;
}

const cleanName = (name) =>
  String(name ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(0, 200) || 'file';

const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

/**
 * Streams an upload to disk. `meta` comes from the browser (name, wanted kind,
 * picture size, voice length and waveform); the stored kind and type come from
 * the file's actual bytes, so a renamed HTML file can never show as a photo.
 */
export async function saveUpload(req, userId, meta) {
  const stored = randomUUID();
  const path = join(uploadDir, stored);
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxUploadBytes) throw new AppError(413, `Files can be up to ${Math.round(maxUploadBytes / 1024 / 1024)} MB.`);
          yield chunk;
        }
      },
      createWriteStream(path),
    );
    if (!size) throw new AppError(400, 'That file is empty.');

    const head = Buffer.alloc(16);
    const fh = await open(path, 'r');
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const real = sniff(head);

    const wanted = meta.kind;
    let kind = 'file';
    let mime = 'application/octet-stream';
    if (real?.kind === 'image' && wanted === 'image') {
      kind = 'image';
      mime = real.mime;
    } else if (real?.kind === 'av' && wanted === 'voice') {
      kind = 'voice';
      mime = { webm: 'audio/webm', mp4: 'audio/mp4', ogg: 'audio/ogg', mpeg: 'audio/mpeg' }[real.mime];
    } else if (real?.kind === 'av' && (real.mime === 'mp4' || real.mime === 'webm') && /^video\//.test(meta.mime ?? '')) {
      kind = 'video';
      mime = real.mime === 'mp4' ? 'video/mp4' : 'video/webm';
    } else if (real?.kind === 'image') {
      mime = real.mime; // an image sent as a file: still downloaded, not shown inline
    }

    const waveform = Array.isArray(meta.waveform)
      ? meta.waveform.slice(0, 64).map((v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0))))
      : null;
    const row = await one(
      `INSERT INTO attachments (uploader_id, kind, name, mime, size, width, height, duration, waveform, stored)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        userId, kind, cleanName(meta.name), mime, size,
        kind === 'image' || kind === 'video' ? num(meta.width, 20000) : null,
        kind === 'image' || kind === 'video' ? num(meta.height, 20000) : null,
        kind === 'voice' || kind === 'video' ? num(meta.duration, 24 * 3600) : null,
        kind === 'voice' && waveform ? JSON.stringify(waveform) : null,
        stored,
      ],
    );
    return publicAttachment(row);
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

export function publicAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    width: row.width ?? null,
    height: row.height ?? null,
    duration: row.duration ?? null,
    waveform: row.waveform ?? null,
    url: `/api/files/${row.id}`,
  };
}

/**
 * Links a just-uploaded file to the message that sends it. Only its uploader
 * can, and only once. Runs inside the message's transaction.
 */
export async function linkAttachment(client, attachmentId, userId, column, messageId) {
  assertUuid(attachmentId, 'file');
  const { rows } = await client.query(
    `UPDATE attachments SET ${column} = $3
     WHERE id = $1 AND uploader_id = $2 AND dm_message_id IS NULL AND room_message_id IS NULL
     RETURNING *`,
    [attachmentId, userId, messageId],
  );
  if (!rows[0]) throw new AppError(400, 'That file was already sent or has expired. Attach it again.');
  return publicAttachment(rows[0]);
}

/**
 * A forwarded message's own copy of a sent file (its own file on disk and
 * row): deleting one message never takes the other's file with it. The new
 * row's id, ready to link like a fresh upload by `userId`.
 */
export async function copyAttachment(row, userId) {
  const stored = randomUUID();
  await copyFile(join(uploadDir, row.stored), join(uploadDir, stored));
  const copy = await one(
    `INSERT INTO attachments (uploader_id, kind, name, mime, size, width, height, duration, waveform, stored)
     SELECT $2, kind, name, mime, size, width, height, duration, waveform, $3 FROM attachments WHERE id = $1
     RETURNING id`,
    [row.id, userId, stored],
  );
  if (!copy) {
    await rm(join(uploadDir, stored), { force: true });
    throw new AppError(404, 'That file is gone.');
  }
  return copy.id;
}

/** A copy made for a forward that couldn't go after all. */
export async function discardAttachment(id) {
  const row = await one('DELETE FROM attachments WHERE id = $1 AND dm_message_id IS NULL AND room_message_id IS NULL RETURNING stored', [id]);
  if (row) await rm(join(uploadDir, row.stored), { force: true });
}

/** The file on disk and how to serve it, if this person may open it. */
export async function fileFor(id, userId) {
  assertUuid(id, 'file');
  const row = await one(
    `SELECT a.*, d.sender_id, d.recipient_id, r.room_id,
            EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.room_id AND m.user_id = $2) AS member
     FROM attachments a
     LEFT JOIN dm_messages d ON d.id = a.dm_message_id
     LEFT JOIN room_messages r ON r.id = a.room_message_id
     WHERE a.id = $1`,
    [id, userId],
  );
  const allowed = row && (row.uploader_id === userId || row.sender_id === userId || row.recipient_id === userId || row.member);
  if (!allowed) throw notFound("That file doesn't exist or isn't shared with you.");
  return { path: join(uploadDir, row.stored), row };
}

/** Types that are safe to show inside the page; everything else is only downloaded. */
export const showsInline = (row) => row.kind === 'image' || row.kind === 'video' || row.kind === 'voice';

/** Sends a sent file (from fileFor, or a report's for the host admin); ?download saves it. */
export function sendFile(req, res, { path, row }) {
  const inline = showsInline(row) && req.query.download === undefined;
  res.setHeader('Content-Type', inline ? row.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Opened on its own, a file can never run code in the app's name.
  res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path, { acceptRanges: true, dotfiles: 'allow' });
}

/** A file that's in a report, for the host admin (null when it's been deleted since). */
export async function reportedFile(id) {
  const row = await one('SELECT * FROM attachments WHERE id = $1', [id]);
  return row ? { path: join(uploadDir, row.stored), row } : null;
}

/**
 * Removes files that were uploaded but never sent (after a day), and files
 * whose message or room was deleted.
 */
export async function cleanUploads() {
  const { rows } = await query(
    `DELETE FROM attachments
     WHERE dm_message_id IS NULL AND room_message_id IS NULL AND created_at < now() - interval '1 day'
     RETURNING stored`,
  );
  for (const r of rows) await rm(join(uploadDir, r.stored), { force: true });
  const known = new Set((await query('SELECT stored FROM attachments')).rows.map((r) => r.stored));
  for (const name of await readdir(uploadDir)) {
    // The small copies' folder (cleaned below).
    if (known.has(name) || name.startsWith('.')) continue;
    const info = await stat(join(uploadDir, name)).catch(() => null);
    // Leave files that may still be uploading.
    if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000) await rm(join(uploadDir, name), { force: true });
  }
  // Small copies of files that are gone.
  for (const name of await readdir(thumbDir)) {
    if (!known.has(name.replace(/-\d+\.jpg(\.part)?$/, ''))) await rm(join(thumbDir, name), { force: true });
  }
}
