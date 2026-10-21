// Reads what an Android app file (APK) says about itself: its package name,
// version and signing certificate. Used to check an app update the host
// uploads before phones are offered it. No dependencies: an APK is a zip file
// with a binary AndroidManifest.xml, signed with APK Signature Scheme v2/v3.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const fail = (why) => {
  throw Object.assign(new Error(why), { apk: true });
};

// ── The zip file ──────────────────────────────────────────────────────

function endOfCentralDirectory(buf) {
  const from = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return { entries: buf.readUInt16LE(i + 10), size: buf.readUInt32LE(i + 12), offset: buf.readUInt32LE(i + 16) };
    }
  }
  fail("That isn't an Android app file (.apk).");
}

function readEntry(buf, eocd, wanted) {
  let p = eocd.offset;
  for (let n = 0; n < eocd.entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      if (buf.readUInt32LE(local) !== 0x04034b50) fail('The app file is damaged.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      fail('The app file uses an unknown compression.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ── Android's binary XML ──────────────────────────────────────────────

const ATTR_IDS = { 0x0101021b: 'versionCode', 0x0101021c: 'versionName', 0x0101020c: 'minSdkVersion' };

function readStringPool(buf, at) {
  const count = buf.readUInt32LE(at + 8);
  const utf8 = (buf.readUInt32LE(at + 16) & 0x100) !== 0;
  const stringsStart = at + buf.readUInt32LE(at + 20);
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(at + 28 + i * 4);
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1; // length in UTF-16 units
      let len = buf[p];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p + 1], p += 2;
      else p += 1;
      strings.push(buf.toString('utf8', p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2), p += 4;
      else p += 2;
      strings.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return strings;
}

/** The <manifest> element's package and version, and <uses-sdk>'s minimum. */
function readManifest(xml) {
  if (xml.readUInt16LE(0) !== 0x0003) fail('The app file has an unreadable manifest.');
  let strings = [];
  let resIds = [];
  const found = {};
  for (let p = xml.readUInt16LE(2); p + 8 <= xml.length; ) {
    const type = xml.readUInt16LE(p);
    const size = xml.readUInt32LE(p + 4);
    if (!size) break;
    if (type === 0x0001) strings = readStringPool(xml, p);
    else if (type === 0x0180) {
      resIds = [];
      for (let i = p + 8; i < p + size; i += 4) resIds.push(xml.readUInt32LE(i));
    } else if (type === 0x0102) {
      const element = strings[xml.readUInt32LE(p + 20)];
      if (element === 'manifest' || element === 'uses-sdk') {
        const attrStart = p + 16 + xml.readUInt16LE(p + 24);
        const attrSize = xml.readUInt16LE(p + 26);
        const attrCount = xml.readUInt16LE(p + 28);
        for (let i = 0; i < attrCount; i++) {
          const a = attrStart + i * attrSize;
          const nameIdx = xml.readUInt32LE(a + 4);
          const name = ATTR_IDS[resIds[nameIdx]] ?? strings[nameIdx];
          const raw = xml.readInt32LE(a + 8);
          const dataType = xml[a + 15];
          const data = xml.readUInt32LE(a + 16);
          const value = raw >= 0 ? strings[raw] : dataType === 0x03 ? strings[data] : dataType >= 0x10 && dataType <= 0x1f ? data : null;
          if (element === 'manifest' && ['package', 'versionCode', 'versionName'].includes(name)) found[name] = value;
          if (element === 'uses-sdk' && name === 'minSdkVersion') found.minSdk = Number(value);
        }
      }
    }
    p += size;
  }
  return found;
}

// ── The signing certificate (APK Signature Scheme v2 / v3) ─────────────

function lengthPrefixed(buf, p) {
  const len = buf.readUInt32LE(p);
  return { body: buf.subarray(p + 4, p + 4 + len), next: p + 4 + len };
}

function signingCertificate(buf, cdOffset) {
  if (cdOffset < 32 || buf.toString('latin1', cdOffset - 16, cdOffset) !== 'APK Sig Block 42') return null;
  const blockSize = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - blockSize - 8;
  if (start < 0) return null;
  const blocks = {};
  for (let p = start + 8; p < cdOffset - 24; ) {
    const len = Number(buf.readBigUInt64LE(p));
    blocks[buf.readUInt32LE(p + 8)] = buf.subarray(p + 12, p + 8 + len);
    p += 8 + len;
  }
  // v3 and v2 put the certificates in the same place within a signer.
  const block = blocks[0xf05368c0] ?? blocks[0x7109871a];
  if (!block) return null;
  const signers = lengthPrefixed(block, 0).body;
  const signer = lengthPrefixed(signers, 0).body;
  const signedData = lengthPrefixed(signer, 0).body;
  const afterDigests = lengthPrefixed(signedData, 0).next;
  const certificates = lengthPrefixed(signedData, afterDigests).body;
  const cert = lengthPrefixed(certificates, 0).body;
  return createHash('sha256').update(cert).digest('hex');
}

/**
 * { package, versionCode, versionName, minSdk, certSha256 } of an APK in
 * memory. Throws an error with `apk: true` and a plain reason when it isn't one.
 */
export function readApk(buf) {
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) fail("That isn't an Android app file (.apk).");
  try {
    const eocd = endOfCentralDirectory(buf);
    const manifest = readEntry(buf, eocd, 'AndroidManifest.xml');
    if (!manifest) fail("That isn't an Android app file (.apk): it has no manifest.");
    const m = readManifest(manifest);
    const versionCode = Number(m.versionCode);
    if (!m.package || !Number.isSafeInteger(versionCode) || versionCode <= 0) fail("Couldn't read the app's version from the file.");
    return {
      package: String(m.package),
      versionCode,
      versionName: String(m.versionName ?? versionCode),
      minSdk: Number.isFinite(m.minSdk) ? m.minSdk : null,
      certSha256: signingCertificate(buf, eocd.offset),
    };
  } catch (err) {
    if (err.apk) throw err;
    fail('The app file is damaged or not an APK.');
  }
}
