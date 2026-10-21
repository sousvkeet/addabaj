import { Router } from 'express';
import { AppError } from '../errors.js';
import { fileFor, saveUpload, showsInline } from '../services/uploads.js';

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

filesRouter.get('/:id', async (req, res) => {
  const { path, row } = await fileFor(req.params.id, req.userId);
  const inline = showsInline(row) && req.query.download === undefined;
  res.setHeader('Content-Type', inline ? row.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Opened on its own, a file can never run code in the app's name.
  res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path, { acceptRanges: true, dotfiles: 'allow' });
});
