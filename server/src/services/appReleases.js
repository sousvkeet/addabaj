// Android app updates: the host uploads a new APK (Admin › App updates), and
// every copy of the app checks for it when it opens. A release can be made
// mandatory: older apps then must update before going on. Files are kept in
// server/data/app-releases/ (back it up with the database).
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { android, rootDir } from '../config.js';
import { one, query } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { getIO } from '../realtime.js';
import { readApk } from './apk.js';

export const releasesDir = process.env.APP_RELEASES_DIR || resolve(rootDir, 'server/data/app-releases');
mkdirSync(releasesDir, { recursive: true });
const MAX_BYTES = Math.max(1, Number(process.env.APP_MAX_MB ?? 150) || 150) * 1024 * 1024;

/** "f0:BA:1c…" or "f0ba1c…" → "f0ba1c…" */
const hex = (s) => String(s).replace(/[^0-9a-f]/gi, '').toLowerCase();
const configuredCerts = android.certs.map(hex);
const colons = (h) => h?.toUpperCase().match(/../g)?.join(':') ?? null;

export function publicRelease(r) {
  if (!r) return null;
  return {
    versionCode: r.version_code,
    versionName: r.version_name,
    notes: r.notes,
    mandatory: r.mandatory,
    size: Number(r.size),
    sha256: r.sha256,
    minSdk: r.min_sdk,
    publishedAt: r.created_at,
    url: `/api/app/download/${r.version_code}`,
  };
}

const adminRelease = (r) => ({ ...publicRelease(r), certSha256: colons(r.cert_sha256), uploadedBy: r.uploader_name ?? null });

/** The newest release, and the oldest version allowed to keep running (the newest mandatory one). */
export async function currentVersions() {
  const latest = await one('SELECT * FROM app_releases ORDER BY version_code DESC LIMIT 1');
  const required = await one('SELECT version_code, version_name FROM app_releases WHERE mandatory ORDER BY version_code DESC LIMIT 1');
  return {
    latest: publicRelease(latest),
    required: required ? { versionCode: required.version_code, versionName: required.version_name } : null,
  };
}

export async function listReleases() {
  const { rows } = await query(
    `SELECT r.*, u.name AS uploader_name FROM app_releases r LEFT JOIN users u ON u.id = r.uploaded_by ORDER BY r.version_code DESC`,
  );
  return rows.map(adminRelease);
}

/** Tells every open app and page that the versions changed (a new or newly mandatory release). */
async function announce() {
  getIO()?.emit('app:versions', await currentVersions());
}

/**
 * Saves an uploaded APK after checking it really is the next version of this
 * app, signed with the same key (Android refuses to update otherwise).
 */
export async function saveRelease(req, userId, { notes = '', mandatory = false } = {}) {
  const temp = join(releasesDir, `upload-${randomUUID()}.part`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_BYTES) throw new AppError(413, `App files can be up to ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(temp),
    );
    if (!size) throw new AppError(400, 'That file is empty.');
    let apk;
    try {
      apk = readApk(await readFile(temp));
    } catch (err) {
      throw new AppError(400, err.apk ? err.message : "That isn't an Android app file (.apk).");
    }
    if (apk.package !== android.package) throw new AppError(400, `That's a different app (${apk.package}), not ${android.package}.`);
    const latest = await one('SELECT version_code, version_name, cert_sha256 FROM app_releases ORDER BY version_code DESC LIMIT 1');
    if (latest && apk.versionCode <= latest.version_code) {
      throw new AppError(409, `This is version ${apk.versionName} (${apk.versionCode}), but ${latest.version_name} (${latest.version_code}) is already up. Raise versionCode in android/app/build.gradle and build again.`);
    }
    const expected = latest?.cert_sha256 ? [latest.cert_sha256] : configuredCerts;
    if (!apk.certSha256) throw new AppError(400, "This app file isn't signed (APK Signature Scheme v2). Build it with assembleRelease.");
    if (expected.length && !expected.includes(apk.certSha256)) {
      throw new AppError(400, 'This app file is signed with a different key than the installed app, so phones would refuse to update. Sign it with the same key (android/keystore).');
    }
    const sha256 = hash.digest('hex');
    const stored = `${apk.versionCode}-${sha256.slice(0, 12)}.apk`;
    // Claim the version first, so two uploads of it at once can't both land.
    const claimed = await one(
      `INSERT INTO app_releases (version_code, version_name, notes, mandatory, size, sha256, cert_sha256, min_sdk, stored, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (version_code) DO NOTHING RETURNING version_code`,
      [apk.versionCode, apk.versionName, String(notes).slice(0, 2000), !!mandatory, size, sha256, apk.certSha256, apk.minSdk, stored, userId],
    );
    if (!claimed) throw new AppError(409, `Version ${apk.versionName} (${apk.versionCode}) was just uploaded.`);
    try {
      await rename(temp, join(releasesDir, stored));
    } catch (err) {
      await query('DELETE FROM app_releases WHERE version_code = $1', [apk.versionCode]);
      throw err;
    }
    await announce();
    return (await listReleases()).find((r) => r.versionCode === apk.versionCode);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function updateRelease(versionCode, { notes, mandatory }) {
  const row = await one(
    `UPDATE app_releases SET notes = coalesce($2, notes), mandatory = coalesce($3, mandatory) WHERE version_code = $1 RETURNING version_code`,
    [versionCode, notes === undefined ? null : String(notes).slice(0, 2000), mandatory === undefined ? null : !!mandatory],
  );
  if (!row) throw notFound("That release doesn't exist.");
  await announce();
}

export async function deleteRelease(versionCode) {
  const row = await one('DELETE FROM app_releases WHERE version_code = $1 RETURNING stored', [versionCode]);
  if (!row) throw notFound("That release doesn't exist.");
  await rm(join(releasesDir, row.stored), { force: true });
  await announce();
}

/** The file of a release, for downloading. */
export async function releaseFile(versionCode) {
  const row = await one('SELECT version_name, stored, size FROM app_releases WHERE version_code = $1', [versionCode]);
  if (!row) throw notFound("That version of the app isn't available.");
  return { path: join(releasesDir, row.stored), name: `AddaKhana-${row.version_name}.apk`, size: Number(row.size) };
}
