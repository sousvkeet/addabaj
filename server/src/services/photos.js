// Profile photos. The app crops and shrinks a photo to a square JPEG before
// sending it; the server checks it really is one, keeps only the picture
// (dropping camera details, location and anything tucked in after it) and
// stores it as <user id>-<version>.jpg. A new photo gets a new version, so its
// address changes and old copies can be cached for good.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rootDir } from '../config.js';
import { one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { getIO, userChannel } from '../realtime.js';
import { contactIds, photoUrl, roomPhotoUrl } from './users.js';

export const photoDir = process.env.PHOTO_DIR || resolve(rootDir, 'server/data/photos');
mkdirSync(photoDir, { recursive: true });

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 2048;

const fileFor = (userId, version) => join(photoDir, `${userId}-${version}.jpg`);
const roomFileFor = (roomId, version) => join(photoDir, `room-${roomId}-${version}.jpg`);
const notAPhoto = () => new AppError(400, "That isn't a picture the app can use. Try another one.");

// Start-of-frame markers (they carry the picture's size): C0–CF except DHT (C4), JPG (C8) and DAC (CC).
const isFrame = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
// What a picture needs: its frame, tables, restart interval, JFIF and Adobe colour headers.
const isPicture = (m) => isFrame(m) || m === 0xc4 || m === 0xcc || m === 0xdb || m === 0xdd || m === 0xe0 || m === 0xee;

/** A JPEG with only what it takes to show the picture, and its size. Throws for anything else. */
export function cleanJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw notAPhoto();
  const parts = [buf.subarray(0, 2)];
  let width = 0;
  let height = 0;
  let i = 2;
  for (;;) {
    if (i + 4 > buf.length || buf[i] !== 0xff) throw notAPhoto();
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: picture data to the end marker. Anything after it is dropped.
      const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (end <= i || !width) throw notAPhoto();
      parts.push(buf.subarray(i, end + 2));
      break;
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) throw notAPhoto();
    if (isFrame(marker)) {
      if (length < 7) throw notAPhoto();
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    if (isPicture(marker)) parts.push(buf.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  if (width < MIN_SIDE || height < MIN_SIDE) throw new AppError(400, 'That photo is too small. Choose a bigger one.');
  if (width > MAX_SIDE || height > MAX_SIDE) throw new AppError(400, 'That photo is too big. The app shrinks photos before sending; update the app and try again.');
  return { jpeg: Buffer.concat(parts), width, height };
}

/**
 * Tells everyone who can see this person (their contacts and their own apps)
 * that their photo changed, and updates what their live connections send
 * with their messages and calls.
 */
async function announce(userId, version) {
  const io = getIO();
  if (!io) return;
  const photo = photoUrl(userId, version);
  for (const socket of io.of('/').sockets.values()) {
    if (socket.data.userId === userId && socket.data.user) socket.data.user.photo = photo;
  }
  const channels = [userId, ...(await contactIds(userId))].map(userChannel);
  io.to(channels).emit('user:updated', { user: { id: userId, photo } });
}

/** A checked, cleaned photo and its version (from its contents). */
function prepare(buf) {
  if (!buf?.length) throw notAPhoto();
  if (buf.length > MAX_PHOTO_BYTES) throw new AppError(413, 'That photo is too big. Choose a smaller one.');
  const { jpeg } = cleanJpeg(buf);
  return { jpeg, version: createHash('sha256').update(jpeg).digest('hex').slice(0, 16) };
}

/** Sets someone's photo from a JPEG; returns the new address. */
export async function savePhoto(userId, buf) {
  const { jpeg, version } = prepare(buf);
  await writeFile(fileFor(userId, version), jpeg);
  const row = await one(
    `UPDATE users u SET photo = $2 FROM (SELECT id, photo FROM users WHERE id = $1) old
     WHERE u.id = old.id RETURNING old.photo AS previous`,
    [userId, version],
  );
  if (!row) {
    await rm(fileFor(userId, version), { force: true });
    throw notFound("That account doesn't exist.");
  }
  if (row.previous && row.previous !== version) await rm(fileFor(userId, row.previous), { force: true });
  await announce(userId, version);
  return photoUrl(userId, version);
}

/** Back to initials. */
export async function removePhoto(userId) {
  const row = await one(
    `UPDATE users u SET photo = NULL FROM (SELECT id, photo FROM users WHERE id = $1) old
     WHERE u.id = old.id RETURNING old.photo AS previous`,
    [userId],
  );
  if (!row) throw notFound("That account doesn't exist.");
  if (row.previous) {
    await rm(fileFor(userId, row.previous), { force: true });
    await announce(userId, null);
  }
}

/** The file of someone's current photo (an old version is gone). */
export async function photoFile(userId, version) {
  const row = await one('SELECT photo FROM users WHERE id = $1 AND disabled_at IS NULL', [userId]);
  if (!row?.photo || row.photo !== version) throw notFound('That photo has changed.');
  return fileFor(userId, version);
}

/** An account is being removed: its photo goes too. */
export async function forgetPhoto(userId, version) {
  if (version) await rm(fileFor(userId, version), { force: true });
}

// ── Room photos ───────────────────────────────────────────────────────

/** Sets a room's photo from a JPEG; returns its address. (The caller checks the person is the room's admin.) */
export async function saveRoomPhoto(roomId, buf) {
  const { jpeg, version } = prepare(buf);
  await writeFile(roomFileFor(roomId, version), jpeg);
  const row = await one(
    `UPDATE rooms r SET photo = $2 FROM (SELECT id, photo FROM rooms WHERE id = $1) old WHERE r.id = old.id RETURNING old.photo AS previous`,
    [roomId, version],
  );
  if (!row) {
    await rm(roomFileFor(roomId, version), { force: true });
    throw notFound("That room doesn't exist.");
  }
  if (row.previous && row.previous !== version) await rm(roomFileFor(roomId, row.previous), { force: true });
  return roomPhotoUrl(roomId, version);
}

/** Back to the room's letter; false when it had no photo. */
export async function removeRoomPhoto(roomId) {
  const row = await one(
    `UPDATE rooms r SET photo = NULL FROM (SELECT id, photo FROM rooms WHERE id = $1) old WHERE r.id = old.id RETURNING old.photo AS previous`,
    [roomId],
  );
  if (!row) throw notFound("That room doesn't exist.");
  if (row.previous) await rm(roomFileFor(roomId, row.previous), { force: true });
  return !!row.previous;
}

export async function roomPhotoFile(roomId, version) {
  const row = await one('SELECT photo FROM rooms WHERE id = $1', [roomId]);
  if (!row?.photo || row.photo !== version) throw notFound('That photo has changed.');
  return roomFileFor(roomId, version);
}

/** A room is being deleted: its photo goes too. */
export async function forgetRoomPhoto(roomId, version) {
  if (version) await rm(roomFileFor(roomId, version), { force: true });
}
