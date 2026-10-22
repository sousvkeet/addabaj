// Link previews: a message's first link gets a card with the page's title,
// description, site and picture. The server fetches the page (with watch
// together's guard: no private or local addresses, checked on every redirect),
// reads just its <head>, and keeps the picture itself, so nobody's browser
// loads anything from the other site. Each address is fetched once a day at most.
import { createHash } from 'node:crypto';
import { one, query } from '../db.js';
import { getIO, roomChannel, userChannel } from '../realtime.js';
import { guardedRequest, readText } from '../stream/http.js';
import { messaging } from './site.js';

const UA = 'Mozilla/5.0 (compatible; AddaKhanaBot/1.0; +link previews)';
const DAY = 24 * 3600_000;
const MAX_HTML = 800_000;
const MAX_IMAGE = 1_500_000;
/** The whole fetch (page and picture) gives up after this. */
const DEADLINE = 10_000;

// http(s) links; the same rule as the app's (client/src/lib/links.ts).
const LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,!?;:'"’”)\]]+$/;

/** A link as it ends in the text: without a sentence's full stop or closing bracket (unless it opened one). */
export function trimLink(raw) {
  let url = raw;
  for (;;) {
    const m = TRAILING.exec(url);
    if (!m) break;
    const tail = m[0];
    // Keep a ")" that closes a "(" inside the link (Wikipedia's "…_(film)").
    if (tail.startsWith(')') && (url.match(/\(/g)?.length ?? 0) > (url.slice(0, -tail.length).match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

/** The first link in a message's text, or null. */
export function firstLink(text) {
  LINK.lastIndex = 0;
  const m = LINK.exec(text ?? '');
  if (!m) return null;
  const url = trimLink(m[0]);
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** <meta property|name="…" content="…"> tags, by lower-case name (the first of each). */
function metaTags(head) {
  const out = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return m ? (m[1] ?? m[2] ?? m[3]) : null;
    };
    const key = (attr('property') ?? attr('name'))?.toLowerCase();
    const content = attr('content');
    if (key && content && !(key in out)) out[key] = content;
  }
  return out;
}

/** What a picture file really is, from its first bytes (only these are kept). */
function imageType(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function readBytes(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/** Fetches a page's picture and keeps it here; its address on this server, or null. */
async function keepImage(url) {
  const { res } = await guardedRequest(url, { headers: { 'user-agent': UA, accept: 'image/*' }, maxRedirects: 4, timeout: 6000 });
  if (res.statusCode !== 200 || Number(res.headers['content-length'] ?? 0) > MAX_IMAGE) {
    res.resume();
    return null;
  }
  const bytes = await readBytes(res, MAX_IMAGE);
  const type = bytes?.length ? imageType(bytes) : null;
  if (!type) return null;
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  await query('INSERT INTO preview_images (id, content_type, bytes) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, type, bytes]);
  return `/api/previews/${id}`;
}

/** Fetches what a link's card shows, or null when there's nothing worth showing. */
async function fetchPreview(url) {
  const { res, url: at } = await guardedRequest(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en' },
    maxRedirects: 5,
    timeout: 6000,
  });
  if (res.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(String(res.headers['content-type'] ?? ''))) {
    res.resume();
    return null;
  }
  const html = await readText(res, MAX_HTML);
  const end = html.search(/<\/head>|<body[\s>]/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 300_000);
  const meta = metaTags(head);
  const title = decode(meta['og:title'] ?? meta['twitter:title'] ?? /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? '');
  if (!title) return null;
  const description = decode(meta['og:description'] ?? meta['twitter:description'] ?? meta.description ?? '');
  const site = decode(meta['og:site_name'] ?? '') || new URL(at).hostname.replace(/^www\./, '');
  const picture = meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image'] ?? meta['twitter:image:src'];
  let image = null;
  if (picture) {
    try {
      image = await keepImage(new URL(decode(picture), at).href);
    } catch {
      // The card goes without its picture.
    }
  }
  return { url, title: clip(title, 200), description: clip(description, 300), site: clip(site, 80), image };
}

/** A link's card: from the last day's fetch of that address, or fetched now (null: none). */
export async function previewFor(url) {
  const cached = await one('SELECT data, fetched_at FROM link_previews WHERE url = $1', [url]);
  if (cached && Date.now() - cached.fetched_at.getTime() < DAY) return cached.data;
  let data = null;
  try {
    data = await Promise.race([fetchPreview(url), new Promise((r) => setTimeout(() => r(null), DEADLINE))]);
  } catch {
    data = null;
  }
  await query(
    `INSERT INTO link_previews (url, data, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (url) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`,
    [url, data ? JSON.stringify(data) : null],
  );
  return data;
}

/**
 * Gives a just-sent (or edited) message its link's card, when the host has
 * previews on: saved with the message and sent to whoever has the chat.
 */
export function schedulePreview(scope, message) {
  if (!messaging().linkPreviews || message.deletedAt) return;
  const url = firstLink(message.body);
  if (!url) return;
  void (async () => {
    const preview = await previewFor(url);
    if (!preview) return;
    const table = scope === 'room' ? 'room_messages' : 'dm_messages';
    // Still the link it says (an edit may have changed it meanwhile).
    const row = await one(`UPDATE ${table} SET preview = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING body`, [message.id, JSON.stringify(preview)]);
    if (!row || firstLink(row.body) !== url) return;
    const io = getIO();
    if (scope === 'room') io?.to(roomChannel(message.roomId)).emit('msg:preview', { scope, roomId: message.roomId, messageId: message.id, preview });
    else io?.to(userChannel(message.senderId)).to(userChannel(message.recipientId)).emit('msg:preview', { scope, between: [message.senderId, message.recipientId], messageId: message.id, preview });
  })().catch((err) => console.error('Link preview failed:', err.message));
}

/** A kept picture, for GET /api/previews/:id. */
export async function previewImage(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return one('SELECT content_type, bytes FROM preview_images WHERE id = $1', [id]);
}

/** Cards older than a day, and pictures no message shows any more (hourly). */
export async function cleanPreviews() {
  await query(`DELETE FROM link_previews WHERE fetched_at < now() - interval '1 day'`);
  await query(
    `DELETE FROM preview_images p WHERE p.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM dm_messages d WHERE d.preview->>'image' = '/api/previews/' || p.id)
       AND NOT EXISTS (SELECT 1 FROM room_messages r WHERE r.preview->>'image' = '/api/previews/' || p.id)`,
  );
}
