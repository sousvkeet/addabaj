// Keeps server-side fetching (page scans, yt-dlp, the hidden browser, the
// stream relay) away from private networks: localhost, the LAN, cloud metadata
// endpoints and other reserved ranges. Addresses are checked when connecting,
// so redirects and DNS tricks can't sneak past.
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { streaming } from '../config.js';

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['100::', 64], ['64:ff9b::', 96], ['2002::', 16],
]) blocked.addSubnet(address, prefix, 'ipv6');

export class BlockedError extends Error {
  constructor(host) {
    super(`That link points to a private or local address (${host}), which this server won't fetch.`);
    this.status = 400;
    this.expose = true;
    this.code = 'EBLOCKED';
  }
}

export function allowedAddress(ip) {
  if (streaming.allowPrivate) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is matched against the IPv4 rules too.
  return !blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/** Resolves a host and refuses it if any address is private. */
export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!allowedAddress(host)) throw new BlockedError(host);
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`Couldn't find ${host}.`);
  for (const a of addresses) if (!allowedAddress(a.address)) throw new BlockedError(host);
  return addresses;
}

/** Drop-in `lookup` for http/https/net that refuses private addresses at connect time. */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { all: true, verbatim: true, family: options?.family || 0 }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new Error(`Couldn't find ${hostname}.`));
    if (addresses.some((a) => !allowedAddress(a.address))) return callback(new BlockedError(hostname));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * A local, password-protected HTTP proxy that applies the same rules. yt-dlp
 * and the hidden browser send all their traffic through it.
 */
let proxyReady = null;
export function guardProxy() {
  return (proxyReady ??= new Promise((resolve, reject) => {
    const username = 'adda';
    const password = randomBytes(18).toString('base64url');
    const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    const authorized = (req) => {
      const got = Buffer.from(req.headers['proxy-authorization'] ?? '');
      return got.length === expected.length && timingSafeEqual(got, expected);
    };
    const deny = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="adda"\r\nContent-Length: 0\r\n\r\n';

    // Plain-http requests ("GET http://host/path").
    const server = http.createServer(async (req, res) => {
      if (!authorized(req)) return res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="adda"' }).end();
      let target;
      try {
        target = new URL(req.url);
      } catch {
        return res.writeHead(400).end();
      }
      if (target.protocol !== 'http:') return res.writeHead(400).end();
      try {
        const [addr] = await assertPublicHost(target.hostname);
        const headers = { ...req.headers, host: target.host };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = http.request(
          { host: addr.address, family: addr.family, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
        req.pipe(upstream);
      } catch {
        res.writeHead(403).end();
      }
    });

    // HTTPS tunnels ("CONNECT host:443").
    server.on('connect', async (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      if (!authorized(req)) return socket.end(deny);
      const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? '');
      if (!m) return socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      try {
        const [addr] = await assertPublicHost(m[1]);
        const upstream = net.connect({ host: addr.address, port: Number(m[2]), family: addr.family }, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
      } catch {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      }
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.unref();
      resolve({ host: `127.0.0.1:${port}`, username, password, url: `http://${username}:${password}@127.0.0.1:${port}` });
    });
  }));
}
