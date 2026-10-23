import { Router } from 'express';
import { AppError, notFound } from '../errors.js';
import { hasThumb, sendThumb, thumbFor, thumbSize } from '../services/thumbs.js';
import { fileFor, saveUpload, sendFile } from '../services/uploads.js';

export const uploadsRouter = Router();
export const filesRouter = Router();

// A generous per-person limit on uploads (photos are small after the browser shrinks them).
const recent = new Map(); // userId -> timestamps
function allowUpload(userId) {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 60) return false;
  list.push(now);
  recent.set(userId, list);
  return true;
}

// The file is the raw request body; details come in the X-Upload-Meta header.
uploadsRouter.post('/', async (req, res) => {
  if (!allowUpload(req.userId)) throw new AppError(429, 'That’s a lot of uploads. Wait a few minutes and try again.');
  let meta;
  try {
    meta = JSON.parse(decodeURIComponent(String(req.headers['x-upload-meta'] ?? '{}')));
  } catch {
    throw new AppError(400, 'The file details were unreadable. Try again.');
  }
  const attachment = await saveUpload(req, req.userId, meta ?? {});
  res.status(201).json({ attachment });
});

// ?thumb=<size>: a small copy of a photo, or a video's picture, for chat bubbles (services/thumbs.js).
filesRouter.get('/:id', async (req, res) => {
  const file = await fileFor(req.params.id, req.userId);
  if (req.query.thumb !== undefined && req.query.download === undefined && hasThumb(file.row)) {
    const size = thumbSize(req.query.thumb);
    const thumb = await thumbFor(file, size);
    if (thumb) return sendThumb(res, thumb);
    // Without FFmpeg a photo for a bubble is sent whole. A video has no picture, and a photo
    // no blurred placeholder (a phone asks for one to save data, not to get the whole photo).
    if (file.row.kind === 'video') throw notFound('This video has no picture.');
    if (size < 320) throw notFound('This photo has no small copy.');
  }
  sendFile(req, res, file);
});
