import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { android, config, limits, rootDir, streaming } from './config.js';
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
import { pushRouter } from './routes/push.js';
import { appRouter } from './routes/app.js';
import { pushEnabled } from './services/push.js';
import { calls } from './socket/calls.js';
import { assertUuid } from './errors.js';
import { cleanUploads, maxUploadBytes } from './services/uploads.js';
import { ensureHostAdmin, loadSite, publicSite } from './services/site.js';
import { loadPrivacy } from './services/privacy.js';
import { ensureRoomCodes } from './services/rooms.js';
import { initSocket } from './socket/index.js';
import { getIceServers, iceTransportPolicy } from './services/ice.js';
import { ensureYtdlp, ytdlpPath, ytdlpVersion } from './stream/ytdlp.js';
import { warmAdBlocker } from './stream/adblock.js';
import { checkBrowser } from './stream/sniff.js';
import { recordBrowserCheck } from './stream/status.js';
import { ffmpegPath } from './stream/ffmpeg.js';
import { resumeMerges } from './stream/merge.js';
import { live } from './socket/live.js';
import { loadSessions } from './services/sessions.js';

await migrate();
await ensureHostAdmin();
await loadSite();
await loadPrivacy();
await ensureRoomCodes();
await loadSessions();
// Logins older than a cookie's life are dropped now and then.
setInterval(() => void loadSessions().catch((err) => console.error('Could not tidy sessions', err)), 12 * 60 * 60 * 1000).unref();

const app = express();
app.disable('x-powered-by');
// Believe a proxy's "the visitor's address is…" only from a proxy on this machine
// (nginx in front), so nobody can fake their address to dodge rate limits.
// Set TRUST_PROXY (e.g. 1) when the proxy runs elsewhere.
const trustProxy = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy === undefined || trustProxy === '' ? 'loopback' : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' || trustProxy);

/**
 * Is this request from our own pages? Browsers say where a request comes from,
 * and another site's page can't pretend otherwise. `Sec-Fetch-Site` is the most
 * reliable signal (it doesn't depend on proxies keeping the Host header); older
 * browsers only send Origin, which is compared with the host. Requests with
 * neither (apps, curl) don't carry a visitor's cookies by accident, so they pass.
 */
const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return true;
  if (site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    const hosts = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean).map((h) => String(h).split(',')[0].trim());
    return hosts.includes(new URL(origin).host);
  } catch {
    return false;
  }
}

// Security headers on everything.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// Another website can't make changes with a visitor's login (cross-site request forgery).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || sameOrigin(req)) return next();
  res.status(403).json({ error: 'This request came from another website, so it was refused.' });
});
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Android App Links: lets the Adda Khana app open this site's room invite links
// (/join/…) directly. The fingerprint is the app's signing certificate (not a
// secret); set ANDROID_CERT_SHA256 when the app is signed with another key.
app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: android.package, sha256_cert_fingerprints: android.certs },
  }]);
});
app.use('/api/auth', authRouter);
// Android app updates (open to everyone: the app checks before signing in).
app.use('/api/app', appRouter);
app.get('/api/config', requireAuth, async (_req, res) => {
  res.json({
    iceServers: await getIceServers(),
    iceTransportPolicy: iceTransportPolicy(),
    limits: { ...limits, uploadMaxBytes: maxUploadBytes },
    push: pushEnabled(),
  });
});
// `build`: which version of the page this server hosts, so pages still running
// an older one (an app left open for days) reload themselves (client realtime.ts).
let siteBuild = null;
app.get('/api/site', requireAuth, (_req, res) => res.json({ ...publicSite(), build: siteBuild }));
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/dms', requireAuth, dmsRouter);
app.use('/api/rooms', requireAuth, roomsRouter);
app.use('/api/invites', requireAuth, invitesRouter);
app.use('/api/stream', requireAuth, streamRouter);
app.use('/api/uploads', requireAuth, uploadsRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/push', requireAuth, pushRouter);
// Declining a call from the phone's notification, without opening the app.
app.post('/api/calls/:callId/decline', requireAuth, (req, res) => {
  calls.decline(req.userId, assertUuid(req.params.callId, 'call'));
  res.status(204).end();
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// In production the server also hosts the built client.
const dist = resolve(rootDir, 'client/dist');
if (existsSync(dist)) {
  // Built files have a content hash in their name, so they can be cached for good
  // (this matters for the 32 MB sound converter).
  app.use('/assets', express.static(resolve(dist, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
  // The service worker (keeps the app's page on the device) is always checked for a newer copy.
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(resolve(dist, 'sw.js'));
  });
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  // The page's content security policy: only our own scripts (plus the tiny theme
  // script inline in index.html, allowed by its hash), YouTube's player, and media
  // from anywhere (watch together plays links straight from their sites).
  const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
  siteBuild = html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com ${inline.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' data: blob: https: http:",
    "connect-src 'self' ws: wss: https: http: blob: data:",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  app.get('/{*splat}', (_req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.sendFile(resolve(dist, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  // A relayed video can fail after it started streaming; just end that response.
  if (res.headersSent) return res.destroy();
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Check the form and try again.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big.' });
  if (err.expose && err.status) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

const server = createServer(app);
// A short heartbeat notices phones whose connection died silently within
// ~16 s (default ~45 s); clients also probe when the person comes back.
const io = new Server(server, {
  serveClient: false,
  pingInterval: 8000,
  pingTimeout: 8000,
  // Connection setup and messages are small; this caps what one event can carry.
  maxHttpBufferSize: 256 * 1024,
  // Another website's page can't open a live connection with a visitor's login.
  allowRequest: (req, callback) => callback(null, sameOrigin(req)),
});
setIO(io);
initSocket(io);

/**
 * Finding videos needs yt-dlp, FFmpeg and a background browser, none of which
 * are in git. Install yt-dlp when it's missing, check the browser starts, and
 * say plainly what's missing (also shown in Host admin › Overview).
 */
async function videoToolsAtStart() {
  if (!ytdlpPath() && streaming.autoInstallYtdlp) {
    console.log('Watch together: yt-dlp is missing; installing it…');
    await ensureYtdlp().catch((err) => console.error(`Watch together: couldn't install yt-dlp (${err.message}); run \`npm run setup:yt-dlp\``));
  }
  const version = await ytdlpVersion();
  console.log(
    version
      ? `Watch together: yt-dlp ${version} ready (site support on)`
      : 'Watch together: yt-dlp not installed; run `npm run setup:yt-dlp` for site support',
  );
  warmAdBlocker();
  const browser = await checkBrowser().catch((err) => ({ ok: false, problem: err.message }));
  recordBrowserCheck(browser);
  console.log(
    browser.ok
      ? `Watch together: background browser ready (deep scan on${streaming.adBlock ? ', ads blocked' : ''})`
      : `Watch together: deep scan unavailable. ${browser.problem}`,
  );
}

server.listen(config.port, async () => {
  console.log(`Adda Khana server listening on http://localhost:${config.port}`);
  if (config.cloudflareTurn) {
    const servers = await getIceServers();
    const turn = servers.flatMap((s) => [].concat(s.urls)).filter((u) => u.startsWith('turn'));
    console.log(turn.length ? `Cloudflare TURN ready (${turn.length} relay URLs)` : 'Cloudflare TURN unavailable; using STUN only');
  }
  if (config.forceTurnRelay) console.log('FORCE_TURN_RELAY is on: all call audio goes through TURN');
  console.log(pushEnabled() ? 'Push notifications: on (Firebase Cloud Messaging)' : 'Push notifications: off (set FCM_SERVICE_ACCOUNT to turn them on)');
  void videoToolsAtStart();
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
