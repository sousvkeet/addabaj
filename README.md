# Adda Khana

A real-time hangout app: one-to-one chat with voice and video calls, plus rooms with group chat, a shared voice table and videos watched together.

## Features

- **Accounts:** sign up and log in with email and password. You stay logged in for 30 days.
- **Presence:** see who's online and when they were last seen.
- **One-to-one chat:** instant delivery, typing indicator, read ticks, unread counts and message history.
- **One-to-one voice and video calls:**
  - Start either kind from a chat. The person you call sees a ring screen; a video call can be answered with video or voice only.
  - During any call you can mute, turn your camera on or off (so a voice call can become a video call), and see when the other person is speaking, muted or has their camera off.
  - Video shows the other person large with you in a corner. On desktop it's a floating window you can shrink back to the call bar; on phones it's full screen.
  - Missed, declined and finished calls are logged in the chat.
- **Watch together (rooms):** a room admin pastes a link, picks a video and quality, and everyone in the room watches it in sync above the chat.
  - **Any link:** a video page on almost any site, YouTube, or a direct `.mp4`, `.webm` or `.m3u8` link. **Find videos** looks for videos the way a download manager does, then lists them with their qualities and sizes, with the best one preselected. Finders, tried in order:
    1. **Site support** by [yt-dlp](https://github.com/yt-dlp/yt-dlp): about 1,800 sites (Facebook, Instagram, X, Dailymotion, Vimeo, TikTok, Reddit, Archive.org, news sites…) plus generic web players.
    2. **Page scan:** `<video>` tags, video metadata and video links anywhere in the page.
    3. **Deep scan:** opens the page in a hidden browser, presses play (skipping ads where it can) and records the video requests it makes. It recognises streams by their content, not only by a `.m3u8` name.

    Each find is checked for length. Short clips (under 30 s: previews, intros, ads) are dropped when a real video (a minute or longer) is on the page. If only short clips turn up, the next finder still runs. Results from page scans are listed longest first.
  - **Relay:** YouTube plays in YouTube's player. Videos found on web pages play through the server's relay, which adds the headers the site expects and supports seeking. Streams are relayed segment by segment through signed links, so the relay only fetches parts listed in a playlist it served. Direct links play straight from their source and fall back to the relay if a browser can't play them, for example when the site blocks cross-site playback or the link is `http://` on an HTTPS page.
  - **Shared download:** a relayed video file is fetched once into a temporary file that every viewer reads from as it fills, the way a download manager works.
  - **Separate picture and sound:** many sites keep their better qualities (often everything above 360p) as a silent video file plus a separate sound file. With FFmpeg installed, Find videos offers these too, for example "720p MP4, picture and sound joined first". The server downloads both and joins them without re-encoding, so it's quick and loses no quality. The room sees "Getting the video ready…" with progress, and playback starts for everyone together. After a server restart, a joined video is prepared again automatically. This approach comes from [IDM-CLI](https://github.com/rj41-w2/idm-cli).
  - **Getting past blocks:** if a site blocks yt-dlp, it retries impersonating Chrome's network fingerprint. That needs the standalone `yt-dlp_linux` build that `npm run setup:yt-dlp` installs. If a site answers 403 to a video request, the relay retries once as `curl/8.0`.
  - **Extra connections:** like IDM, it can download over several connections at once, up to `STREAM_CONNECTIONS` (default 4). It adds them only while they help: while the file arrives slower than 4 MB/s, and only if each addition speeds things up, so sites that limit each connection get much faster and fast sites stay on one. When the room jumps far ahead, a connection starts right at that point.
    - The site sees one download however many people watch, everyone gets the same data, and seeking back is instant.
    - Jumping beyond the downloaded part is fetched from the site directly.
    - Stream segments are likewise fetched once and shared.
    - Disk use is capped by `STREAM_CACHE_GB` (default 10). Files are removed when the video stops or after 10 idle minutes, and the folder is cleared on start.
  - **Who controls it:** only admins can find, play, pause, seek, change or stop. The server enforces this.
  - **Staying in sync:** the admin who last controlled playback is the host. Every member's player compares itself with the shared timeline every 2 seconds and re-syncs if it drifts. Late joiners start at the current point.
  - **Members' controls:** volume, mute and full screen. If their browser blocks autoplay, they see **Click to watch along**.
  - **What it won't do:** play DRM-protected video (Netflix, Prime Video and similar), get past logins or bot checks, or fetch anything on the server's own machine or network. Each of these is explained when it happens.
- **Microphone, speaker and camera choice:**- **Microphone, speaker and camera choice:** from the account menu, during a call, or under room voice.
  - A live level bar shows which microphone hears you.
  - A test sound checks the speaker. Speaker choice works in Chrome, Edge and Firefox; Safari always uses the system output.
  - A preview checks the camera.
  - Choices apply immediately, even mid-call, are remembered per browser, and fall back to the system default if a device is unplugged.
- **Rooms:**
  - Whoever starts a room is its admin and chooses the maximum members (2–50).
  - Admins can **add** people straight in, or **invite** them so they can accept or decline. Admins can also cancel invites and remove members.
  - The room's creator can make other members admins and can delete the room.
  - The member limit is enforced on the server, including when two people join at the same moment. The limit can't be lowered below the current member count.
- **Room voice (the adda table):** members join a voice channel and sit around a table. Each person's avatar lights up while they speak, and mute shows for everyone. Up to 12 people can talk at once.
- **Layout and themes:** light and dark themes, and layouts that work on phones.

## Stack

| Part | Tech |
|---|---|
| Client | React 19, Vite 7, TypeScript, Tailwind CSS 4, Zustand, React Router 7 |
| Server | Node.js 22, Express 5, Socket.IO 4 |
| Database | PostgreSQL (`pg`); the schema is applied automatically on start |
| Calls | WebRTC peer-to-peer audio and video, with Socket.IO carrying the connection setup messages, and Cloudflare Realtime TURN as the relay |

## Setup

1. Create the two settings files from their examples:
   ```sh
   cp server/.env.example server/.env
   cp client/.env.example client/.env
   ```
   In `server/.env`, set `DATABASE_URL` and a long random `JWT_SECRET`.
2. Create the database:
   ```sh
   createdb adda_khana
   ```
3. Install dependencies, plus yt-dlp for finding videos on most sites:
   ```sh
   npm install
   npm run setup:yt-dlp        # downloads yt-dlp to server/bin/ and checks its checksum
   npm run setup:ffmpeg        # downloads a static FFmpeg (about 160 MB) to server/bin/ and checks its checksum
   npx playwright install chromium   # for the deep scan (optional)
   ```
   Re-run `npm run setup:yt-dlp` now and then; sites change and yt-dlp keeps up.
4. Run in development:
   ```sh
   npm run dev
   ```
   This starts the API on http://localhost:4080 and the app on http://localhost:5180. Open the app URL.

### Settings files

| File | Read by | Holds |
|---|---|---|
| `server/.env` | `server/src/config.js` | `DATABASE_URL`, `JWT_SECRET`, `PORT` (API), `NODE_ENV`, Cloudflare TURN keys, `FORCE_TURN_RELAY`, optional `TURN_*`, and for watch together `YTDLP_PATH`, `DEEP_SCAN`, `STREAM_ALLOW_PRIVATE`, `STREAM_CACHE_GB`, `STREAM_CACHE_DIR`, `STREAM_CONNECTIONS`, `FFMPEG_PATH` |
| `client/.env` | `client/vite.config.ts` | `CLIENT_PORT` (dev server), `API_URL` (where the dev server forwards `/api` and `/socket.io`) |

To change the API port, change `PORT` in `server/.env` and the port in `API_URL` in `client/.env` to match.

Values set in the shell override both files. Only `VITE_`-prefixed variables in `client/.env` reach browser code, so never put secrets there. Both `.env` files are excluded from git; the `.env.example` files are committed.

To try calls by yourself, open a second browser profile or an incognito window and sign up as another person.

## Production

```sh
npm run build        # builds client/dist
NODE_ENV=production npm start
```

The server then serves the app and the API on `PORT` from `server/.env`. `client/.env` is only used by the development server. Two requirements:

- **HTTPS.** Browsers only allow the microphone on HTTPS (or localhost), so put the app behind a TLS proxy such as nginx or Caddy. The proxy must forward WebSocket upgrades for `/socket.io`.
- **TURN relay.** Calls use [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/), for networks that block direct connections. Set `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` in `server/.env`.
  - The server uses that key to request 24-hour TURN credentials and caches them (`server/src/services/ice.js`). The key itself never reaches the browser.
  - Calls connect directly when they can and fall back to Cloudflare's relay over UDP, TCP or TLS on ports 3478, 5349, 443 and 80.
  - `FORCE_TURN_RELAY=true` sends all audio through Cloudflare. This hides users' IP addresses from each other, at the cost of a little delay and more relayed traffic.
  - To use another TURN server, leave the Cloudflare keys empty and set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`.

## Tests

`npm run test:e2e` runs an end-to-end test with real browsers. Start `npm run dev` first. If Playwright's Chromium isn't installed, run `npx playwright install chromium` once.

The test drives three users with fake microphones. It checks the TURN relay with a relay-only connection, and logs which route each call and voice link used. With `FORCE_TURN_RELAY=true`, it fails if any link avoids the relay. It covers:

- sign-up and a wrong-password error,
- chat with typing indicator and read ticks,
- an accepted call, mute, hang-up, and a declined call,
- a video call with real video frames both ways, camera off/on, and switching microphone mid-call,
- creating a room, adding and inviting members, and the room-full limit,
- three-way room voice,
- removing a member, and dark theme.

`npm run test:watch` tests watch together with three people. It covers:

- the admin-only button,
- a refused bad link,
- play, pause and seek staying in sync,
- drift correction and a late joiner,
- the server refusing control from a member,
- stop for everyone,
- YouTube sync,
- finding a video on a Wikimedia Commons page and watching it through the shared download, including a jump ahead,
- a JavaScript-player page caught by the deep scan,
- a direct stream falling back to the relay,
- a Bilibili video whose picture and sound are separate files: joined on the server, then watched in sync with sound,
- clear refusals for DRM, pages without video and private addresses.

The YouTube and web-page checks need internet access.

It serves its own test clip from `tests/fixtures/` on port 4099.

`npm run test:find` checks the video finder and the shared download without internet access. It covers:

- video lengths: MP4 with its index at the start or at the end, WebM, streams, and live streams,
- a page whose 5-second preview clip sits next to a 13-minute stream, where the stream must win,
- a file that a server hands out in 64 KB pieces, which must download completely,
- a site that limits each connection, which must get faster with several connections,
- a site that allows only one connection, which must still download completely,
- a jump far ahead, which must get its data quickly,
- pairing and joining a separate H.264 picture file and AAC sound file into one playable file. This needs FFmpeg.

Screenshots are saved to `tests/screenshots/`.

## Project layout

```
server/src/
  index.js            Express + Socket.IO entry, serves client/dist in production
  schema.sql          Tables (applied on start)
  routes/             REST: auth, users, dms, rooms, invites
  services/rooms.js   Membership checks, member-limit locking, room summaries
  socket/             Realtime: chat, typing, read receipts, calls, room voice
client/src/
  store/              Zustand stores: auth, chat, call (1:1 WebRTC), voice (room mesh)
  realtime.ts         Socket events into the stores
  pages/, components/ UI
tests/e2e.mjs         Browser end-to-end test
```

## Limits to know about

- Videos from web pages are relayed through the server. The site is downloaded from once, but each viewer still uses the server's upload bandwidth. A link found on a page can expire after some hours. The part already downloaded keeps playing, but if a long session stops beyond it, find the video again.
- Some sites throttle or block servers that download a lot. The relay retries hiccups, and players retry a stalled load before showing an error, but a slow site stays slow.
- The server fetches pasted links itself, so it blocks private and local addresses (localhost, your LAN, cloud metadata) on every request, redirect, yt-dlp request and hidden-browser request. To relay from your own network, for example a NAS, set `STREAM_ALLOW_PRIVATE=true`.

- Call and voice state is kept in server memory. Run a single server process; restarting it ends any calls in progress.
- Room voice is a full mesh, meaning each person sends audio directly to every other person. That's why voice is capped at 12 people.
- Any logged-in user can search for every other user by name or email.
