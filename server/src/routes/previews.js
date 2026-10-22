import { Router } from 'express';
import { notFound } from '../errors.js';
import { previewImage } from '../services/previews.js';

export const previewsRouter = Router();

// A link preview's picture, kept here when the message was sent (see
// services/previews.js). Named by its content, so it's cached for good.
previewsRouter.get('/:id', async (req, res) => {
  const image = await previewImage(String(req.params.id));
  if (!image) throw notFound('That picture is gone.');
  res.setHeader('Content-Type', image.content_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(image.bytes);
});
