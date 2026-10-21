import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { config, limits, rootDir } from './config.js';
import { requireAuth } from './auth.js';
import { migrate } from './migrate.js';
import { setIO } from './realtime.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { dmsRouter } from './routes/dms.js';
import { roomsRouter } from './routes/rooms.js';
import { invitesRouter } from './routes/invites.js';
import { streamRouter } from './routes/stream.js';
import { filesRouter, uploadsRouter } from './routes/uploads.js';
import { cleanUploads, maxUploadBytes } from './services/uploads.js';
import { ensureHostAdmin, loadSite, publicSite } from './services/site.js';
import { initSocket } from './socket/index.js';
import { getIceServers, iceTransportPolicy } from './services/ice.js';
import { ytdlpPath } from './stream/ytdlp.js';
import { ffmpegPath } from './stream/ffmpeg.js';
import { resumeMerges } from './stream/merge.js';
import { live } from './socket/live.js';

await migrate();
await ensureHostAdmin();
await loadSite();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.get('/api/config', requireAuth, async (_req, res) => {
  res.json({ iceServers: await getIceServers(), iceTransportPolicy: iceTransportPolicy(), limits: { ...limits, uploadMaxBytes: maxUploadBytes } });
});
app.get('/api/site', requireAuth, (_req, res) => res.json(publicSite()));
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/dms', requireAuth, dmsRouter);
app.use('/api/rooms', requireAuth, roomsRouter);
app.use('/api/invites', requireAuth, invitesRouter);
app.use('/api/stream', requireAuth, streamRouter);
app.use('/api/uploads', requireAuth, uploadsRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// In production the server also hosts the built client.
const dist = resolve(rootDir, 'client/dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  // A relayed video can fail after it started streaming; just end that response.
  if (res.headersSent) return res.destroy();
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Check the form and try again.' });
  if (err.expose && err.status) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

const server = createServer(app);
// A short heartbeat notices phones whose connection died silently within
// ~16 s (default ~45 s); clients also probe when the person comes back.
const io = new Server(server, { serveClient: false, pingInterval: 8000, pingTimeout: 8000 });
setIO(io);
initSocket(io);

server.listen(config.port, async () => {
  console.log(`Adda Khana server listening on http://localhost:${config.port}`);
  if (config.cloudflareTurn) {
    const servers = await getIceServers();
    const turn = servers.flatMap((s) => [].concat(s.urls)).filter((u) => u.startsWith('turn'));
    console.log(turn.length ? `Cloudflare TURN ready (${turn.length} relay URLs)` : 'Cloudflare TURN unavailable; using STUN only');
  }
  if (config.forceTurnRelay) console.log('FORCE_TURN_RELAY is on: all call audio goes through TURN');
  console.log(
    ytdlpPath()
      ? 'Watch together: yt-dlp found (site support on)'
      : 'Watch together: yt-dlp not installed; run `npm run setup:yt-dlp` for site support',
  );
  console.log(
    ffmpegPath()
      ? 'Watch together: FFmpeg found (separate picture and sound can be joined)'
      : 'Watch together: FFmpeg not installed; run `npm run setup:ffmpeg` to offer qualities that need joining',
  );
  resumeMerges().catch((err) => console.error('Could not resume video preparation', err));
  live.clearStale().catch((err) => console.error('Could not clear old live streams', err));
  // Unsent uploads (after a day) and files of deleted messages are removed hourly.
  const clean = () => cleanUploads().catch((err) => console.error('Upload cleanup failed', err));
  clean();
  setInterval(clean, 60 * 60 * 1000).unref();
});
