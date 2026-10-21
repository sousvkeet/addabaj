import { Router } from 'express';
import { notFound } from '../errors.js';
import { currentVersions, releaseFile } from '../services/appReleases.js';

// Android app updates, open to everyone: the app checks before anyone signs
// in (a mandatory update comes first), and the app file isn't a secret.
export const appRouter = Router();

appRouter.get('/version', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await currentVersions());
});

appRouter.get('/download/:code', async (req, res) => {
  const code = Number(req.params.code);
  if (!Number.isSafeInteger(code) || code <= 0) throw notFound("That version of the app isn't available.");
  const file = await releaseFile(code);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Each version's file never changes.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file.path, { acceptRanges: true, dotfiles: 'allow' });
});
