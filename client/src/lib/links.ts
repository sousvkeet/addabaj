// Links in message text: web addresses (http and https only) can be tapped.
// The same rule as the server's, which gives a message's first link its card
// (server/src/services/previews.js).
const LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,!?;:'"’”)\]]+$/;

/** A link as it ends in the text: without a sentence's full stop or closing bracket (unless it opened one). */
function trimLink(raw: string) {
  let url = raw;
  for (;;) {
    const m = TRAILING.exec(url);
    if (!m) break;
    // Keep a ")" that closes a "(" inside the link (Wikipedia's "…_(film)").
    if (m[0].startsWith(')') && (url.match(/\(/g)?.length ?? 0) > (url.slice(0, -m[0].length).match(/\)/g)?.length ?? 0)) break;
    url = url.slice(0, -1);
  }
  return url;
}

export type TextPart = { text: string; href?: string };

/** Text in plain parts and links (`href`: the address to open). */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const url = trimLink(m[0]);
    let href: string;
    try {
      href = new URL(url).href;
    } catch {
      continue;
    }
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ text: url, href });
    at = m.index + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
