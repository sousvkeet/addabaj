// Shared helpers that turn raw finds into the options people pick from.

const PLAYABLE_EXT = new Set(['mp4', 'm4v', 'webm', 'mov']);
const PLAYABLE_VCODEC = /^(avc|h264|vp0?8|vp0?9|av01|hev|hvc|h265)/i;

/** Whether a browser can play this progressive file (by container and codec). */
export function playableFile({ ext, vcodec }) {
  const e = (ext ?? '').toLowerCase();
  const v = (vcodec ?? '').toLowerCase();
  if (v && v !== 'none' && v !== 'unknown' && !PLAYABLE_VCODEC.test(v)) return false; // mp4v, theora, …
  if (e === 'mov') return /^(avc|h264|hev|hvc)/.test(v); // only modern codecs in .mov
  return PLAYABLE_EXT.has(e);
}

export const mayNotPlayEverywhere = (vcodec = '') => /^(hev|hvc|h265)/i.test(vcodec);

export function formatBytes(n) {
  if (!n || !Number.isFinite(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const extLabel = (ext = '') => (ext.toLowerCase() === 'webm' ? 'WebM' : ext.toUpperCase() || 'Video');

/** Media headers worth replaying when relaying (some CDNs check these). */
export function pickHeaders(headers = {}, cookies) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = k.toLowerCase();
    if (['user-agent', 'referer', 'origin', 'cookie'].includes(key) && typeof v === 'string') out[key] = v;
  }
  if (typeof cookies === 'string' && cookies && !out.cookie) {
    // yt-dlp's "name=value; Domain=…; Path=…" list → a Cookie header.
    out.cookie = cookies
      .split(/;\s*/)
      .filter((part) => part.includes('=') && !/^(domain|path|expires|max-age|secure|httponly|samesite)=/i.test(part))
      .join('; ');
  }
  return out;
}

/** HLS playlists that need DRM (Widevine, FairPlay, PlayReady, SAMPLE-AES) can't play here. */
export const playlistHasDrm = (text) =>
  /#EXT-X-(SESSION-)?KEY:[^\n]*(METHOD=SAMPLE-AES|KEYFORMAT="(urn:uuid:|com\.widevine|com\.apple\.streamingkeydelivery|com\.microsoft\.playready))/i.test(text);

/**
 * Labels options, sorts them best-first and marks one as recommended:
 * an adaptive stream if there is one (each viewer gets what their connection
 * can carry), otherwise the sharpest file up to 1080p.
 */
export function finishOptions(options) {
  const files = options
    .filter((o) => o.kind === 'file')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.size ?? 0) - (a.size ?? 0));
  // One file per height: prefer H.264/MP4 (plays everywhere), then the larger one.
  const byHeight = new Map();
  for (const f of files) {
    const key = f.height ?? `x${byHeight.size}`;
    const prev = byHeight.get(key);
    const score = (o) => (/^(avc|h264)/i.test(o.vcodec ?? '') || o.ext === 'mp4' ? 2 : 0) + (mayNotPlayEverywhere(o.vcodec) ? -3 : 0);
    if (!prev || score(f) > score(prev)) byHeight.set(key, f);
  }
  const streams = options.filter((o) => o.kind === 'hls' || o.kind === 'youtube');
  const list = [...streams, ...[...byHeight.values()].slice(0, 6)];

  for (const o of list) {
    if (o.kind === 'youtube') {
      o.label = 'YouTube';
      o.detail = 'Plays in the YouTube player';
    } else if (o.kind === 'hls') {
      o.label = 'Auto';
      o.detail = o.maxHeight ? `Adaptive stream, up to ${o.maxHeight}p` : 'Adaptive stream';
    } else {
      o.label = o.height ? `${o.height}p` : 'Original';
      o.detail = `${extLabel(o.ext)} file${mayNotPlayEverywhere(o.vcodec) ? ', may not play in every browser' : ''}`;
    }
    o.sizeLabel = formatBytes(o.size);
  }
  const best =
    list.find((o) => o.kind === 'youtube' || o.kind === 'hls') ??
    list.find((o) => o.kind === 'file' && (o.height ?? 0) <= 1080 && !mayNotPlayEverywhere(o.vcodec)) ??
    list[0];
  if (best) best.recommended = true;
  return list;
}
