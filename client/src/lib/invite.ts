import { inApp } from './native';
import { toast } from '../store/ui';

/** "K7PQ2XMB" → "K7PQ-2XMB" (easier to read out and type). */
export const formatRoomCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/** The link that opens the join dialog (in the browser, or the Android app). */
export const roomLink = (code: string) => `${location.origin}/join/${code}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copies, with a toast saying what was copied (or how to copy it when the browser won't). */
export async function copyText(text: string, what: string) {
  if (await copy(text)) toast(`${what} copied.`);
  else toast(`Couldn't copy. Select it and copy it yourself: ${text}`, 'error');
}

/**
 * Shares through the phone's share sheet (WhatsApp, Messenger, SMS…): the
 * Android app's own, or the browser's; copies when neither exists.
 */
export async function shareText(text: string, what: string) {
  const bridge = (window as { AddaNative?: { share?: (text: string) => void } }).AddaNative;
  if (inApp && bridge?.share) return bridge.share(text);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
    }
  }
  await copyText(text, what);
}
