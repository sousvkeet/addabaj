import type { Attachment, PreparedFile } from './types';
import { getLimits } from './config';
import { formatBytes } from './format';

const MAX_SIDE = 2048;
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;

const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'photo';

async function shrinkImage(file: File): Promise<PreparedFile | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file); // fails for formats the browser can't show (e.g. HEIC on Chrome)
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  // Animated GIFs stay as they are; small photos too (re-encoding only blurs them).
  if (file.type === 'image/gif' || (scale === 1 && file.size <= SHRINK_ABOVE_BYTES)) {
    bitmap.close();
    return { blob: file, meta: { kind: 'image', name: file.name, mime: file.type, width, height }, previewUrl: URL.createObjectURL(file) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Drawing to a canvas also drops hidden metadata such as where the photo was taken.
  const want = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
  let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, want, 0.85));
  if (!blob || blob.type !== want) blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) return null;
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return {
    blob,
    meta: { kind: 'image', name: `${baseName(file.name)}.${ext}`, mime: blob.type, width: canvas.width, height: canvas.height },
    previewUrl: URL.createObjectURL(blob),
  };
}

function videoInfo(url: string): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const done = (info: { width: number; height: number; duration: number } | null) => {
      v.removeAttribute('src');
      resolve(info);
    };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    v.src = url;
  });
}

/** Gets a picked, pasted or dropped file ready to send. Throws a clear message if it can't be. */
export async function prepareFile(file: File): Promise<PreparedFile> {
  const { uploadMaxBytes } = await getLimits();
  let prepared: PreparedFile | null = null;
  if (/^image\/(jpeg|png|webp|gif|avif|bmp)$/.test(file.type)) prepared = await shrinkImage(file);
  if (!prepared && /^video\/(mp4|webm|quicktime)$/.test(file.type)) {
    const url = URL.createObjectURL(file);
    const info = await videoInfo(url);
    prepared = info
      ? { blob: file, meta: { kind: 'video', name: file.name, mime: file.type, ...info }, previewUrl: url }
      : (URL.revokeObjectURL(url), null);
  }
  prepared ??= { blob: file, meta: { kind: 'file', name: file.name || 'file', mime: file.type || 'application/octet-stream' }, previewUrl: null };
  if (prepared.blob.size > uploadMaxBytes) {
    if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
    throw new Error(`“${file.name}” is ${formatBytes(prepared.blob.size)}. Files can be up to ${formatBytes(uploadMaxBytes)}.`);
  }
  return prepared;
}

/** Uploads with progress (fetch can't report upload progress, XHR can). */
export function uploadFile(file: PreparedFile, onProgress: (percent: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Meta', encodeURIComponent(JSON.stringify(file.meta)));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: { attachment?: Attachment; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) resolve(data.attachment);
      else reject(new Error(data.error ?? 'The upload didn’t go through. Try again.'));
    };
    xhr.onerror = () => reject(new Error('The upload didn’t go through. Check your connection and try again.'));
    xhr.send(file.blob);
  });
}

