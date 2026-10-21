<p align="center">
  <img src="docs/logo.svg" width="88" height="88" alt="Adda Khana logo">
</p>

<h1 align="center">Adda Khana</h1>

<p align="center">
  A real-time hangout app you host yourself: one-to-one chat with voice and video calls,<br>
  rooms with group chat and a live voice table, and videos watched together.
</p>

<p align="center">
  <img src="docs/screenshots/02-chat.jpg" alt="A one-to-one chat with a reply, reactions and a voice message">
</p>

## Contents

- [Highlights](#highlights)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Features](#features)
- [Host admin](#host-admin)
- [Configuration](#configuration)
- [Production](#production)
- [Scripts](#scripts)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Security](#security)
- [Limits to know about](#limits-to-know-about)

## Highlights

- **Chat** one to one or in rooms, with photos, videos, files, voice messages, replies and emoji reactions.
- **Call** with HD voice and video, routed through Cloudflare's TURN relay when networks block direct connections.
- **Hang out** in rooms with a live voice table for up to 12 people, where whoever speaks lights up.
- **Watch together:** paste a link from almost any site, and the server finds the video and keeps everyone in sync. You can also stream a file or your screen live from your device.
- **Run the site** from a host admin panel with live numbers, people, rooms, sign-ups and announcements.
- **Look good** in two themes: "Midnight Aurora" (dark, the default) and "Ocean Mint" (light), with layouts made for phones too.

## Screenshots

| Room with live voice | Host admin |
|---|---|
| ![A room with three people at the voice table](docs/screenshots/03-room-voice.jpg) | ![The host admin overview](docs/screenshots/04-admin.jpg) |
| **Light theme (Ocean Mint)** | **Sign in** |
| ![The chat in the light theme](docs/screenshots/05-light.jpg) | ![The sign-in page](docs/screenshots/01-login.jpg) |

<p align="center">
  <img src="docs/screenshots/06-phone.jpg" width="300" alt="A room on a phone">
</p>

## Quick start

You need **Node.js 20.19 or newer** (22 recommended) and **PostgreSQL 13 or newer**. The server alone runs on Node 20.12 and up; building the client with Vite 7 needs 20.19.

```sh
git clone git@github.com:sousvkeet/addabaj.git adda-khana
cd adda-khana

cp server/.env.example server/.env    # then set DATABASE_URL and a long random JWT_SECRET
cp client/.env.example client/.env
createdb adda_khana                   # the tables are created on first start

npm install
npm run setup:yt-dlp                  # optional: finds videos on about 1,800 sites
npm run setup:ffmpeg                  # optional: joins sites' separate picture and sound (about 160 MB)
npx playwright install chromium       # optional: the deep scan for JavaScript video players

npm run dev
```

Open **http://localhost:5180** and log in as **`admin` / `admin`** to run the site, or create an account. The API runs on http://localhost:4080.

To try calls by yourself, open a second browser profile or an incognito window and sign up as someone else.

## Features

### Accounts and presence

- Sign up and log in with email and password, and stay logged in for 30 days. Change your password from the account menu.
- **Online and last seen:** see who's online and when they were last seen ("Last seen 5 min ago", kept up to date) in chats, room member lists and the people picker.
- **Privacy** (account menu): hide when you're online and last seen, and turn off read receipts. Both work both ways, like most chat apps: if you hide yours, you don't see other people's.

### One-to-one chat

- Instant delivery, typing indicator, unread counts and message history.
- **Ticks** on your messages: a clock while sending, one tick when the server has it, two ticks when it's on their device (delivered, even if they were offline and came back later), and two coloured ticks when they've read it. The chat list shows the ticks of your last message too.
- **Message info:** hover one of your messages (or press and hold it on a phone) and choose Message info to see exactly when it was delivered and read.
- **Photos, files and voice messages** (in rooms too):
  - Attach with the paperclip, paste a picture, or drag files onto the chat. Send up to 10 at once; the caption goes with the first.
  - Photos are shrunk to 2048 px on the long side before sending, which also strips hidden details such as where they were taken. Tap a photo to see it full screen and download it.
  - Videos play in the chat. Other files show as a card with a download button.
  - Tap the microphone to record a voice message (up to 5 minutes), then send or discard it. Voice messages show a waveform you can tap to jump around, and play at 1×, 1.5× or 2×.
  - Upload progress shows on the message, and a failed send can be retried without picking the file again.
- **Replies and reactions:** reply to any message (its quote is shown, and tapping it jumps to the original), and react with 👍 ❤️ 😂 😮 😢 🙏. On a computer, hover a message for the buttons; on a phone, press and hold it.

### Voice and video calls

- Start either kind from a chat. The person you call sees a ring screen, and can answer a video call with video or voice only.
- During a call you can mute, turn your camera on or off (so a voice call can become a video call), and see when the other person is speaking, muted or has their camera off.
- Video shows the other person large with you in a corner. On a computer it's a floating window you can shrink back to the call bar; on phones it's full screen.
- Missed, declined and finished calls are logged in the chat.
- **Microphone, speaker and camera:** choose them from the account menu, during a call, or under room voice.
  - A live level bar shows which microphone hears you, a test sound checks the speaker, and a preview checks the camera.
  - Choices apply immediately, even mid-call, are remembered per browser, and fall back to the system default if a device is unplugged.
  - Speaker choice works in Chrome, Edge and Firefox; Safari always uses the system output.

### Rooms

- Whoever starts a room is its admin and chooses the maximum members (2–50).
- Admins can **add** people straight in, or **invite** them so they can accept or decline. Admins can also cancel invites and remove members.
- The room's creator can make other members admins and can delete the room.
- The member limit is enforced on the server, even when two people join at the same moment, and can't be lowered below the current member count.
- **Seen by:** your room messages get ticks too (delivered when everyone's device has it, coloured when everyone has seen it), and your latest one says who has seen it ("Seen by Rahul and Mitali"). Message info lists who has read it, who has it, and who hasn't received it yet. Rooms always show who has seen a message, like group chats elsewhere.
- **Room voice (the adda table):** members join a voice channel and sit around a table. Each person's avatar lights up while they speak, and mute shows for everyone. Up to 12 people can talk at once.

### Watch together

A room admin picks something to watch, and everyone in the room sees it in sync above the chat.

**From a link.** Paste a video page from almost any site, a YouTube link, or a direct `.mp4`, `.webm` or `.m3u8` link. **Find videos** looks for videos the way a download manager does, then lists them with their qualities and sizes, with the best one preselected. The finders are tried in order:

1. **Site support** by [yt-dlp](https://github.com/yt-dlp/yt-dlp): about 1,800 sites (Facebook, Instagram, X, Dailymotion, Vimeo, TikTok, Reddit, Archive.org, news sites…) plus generic web players.
2. **Page scan:** `<video>` tags, video metadata and video links anywhere in the page.
3. **Deep scan:** opens the page in a hidden browser, presses play (skipping ads where it can) and records the video requests it makes. It recognises streams by their content, not only by a `.m3u8` name.

Each find is checked for length. Short clips under 30 seconds (previews, intros, ads) are dropped when there's a real video of a minute or longer on the page. If only short clips turn up, the next finder still runs.

How linked videos play:

- **Relay:** YouTube plays in YouTube's player. Videos found on web pages play through the server's relay, which adds the headers the site expects and supports seeking. Streams are relayed segment by segment through signed links, so the relay only fetches parts listed in a playlist it served. Direct links play straight from their source and fall back to the relay if a browser can't play them, for example when the site blocks cross-site playback or the link is `http://` on an HTTPS page.
- **Shared download:** a relayed file is fetched once into a temporary file that every viewer reads from as it fills, the way a download manager works.
  - The site sees one download however many people watch, everyone gets the same data, and seeking back is instant. Stream segments are fetched once and shared as well.
  - Disk use is capped by `STREAM_CACHE_GB` (default 10). Files are removed when the video stops or after 10 idle minutes, and the folder is cleared on start.
- **Extra connections:** like IDM, the server can download over several connections at once, up to `STREAM_CONNECTIONS` (default 4). It adds them only while they help: while the file arrives slower than 4 MB/s, and only if each one speeds things up. Sites that limit each connection get much faster, and fast sites stay on one. When the room jumps far ahead, a connection starts right at that point.
- **Separate picture and sound:** many sites keep their better qualities as a silent video file plus a separate sound file. With FFmpeg installed, Find videos offers these too, for example "720p MP4, picture and sound joined first". The server downloads both and joins them without re-encoding, so it's quick and loses no quality. The room sees "Getting the video ready…" with progress, and playback starts for everyone together. This approach comes from [IDM-CLI](https://github.com/rj41-w2/idm-cli).
- **Getting past blocks:** if a site blocks yt-dlp, the server retries while imitating Chrome's network fingerprint (this needs the standalone `yt-dlp_linux` build that `npm run setup:yt-dlp` installs). If a site answers 403 to a video request, the relay retries once as `curl/8.0`.

**Live from your device.** Instead of a link, an admin can pick **From your device**:

- **Stream a video file** from a computer or Android phone. It plays on their device and streams live to the room. They play, pause and seek with their own controls; viewers see a "Paused" note and a progress bar. Muting their own speakers doesn't mute the stream.
- **Movie sound is fixed automatically.** Many movie files have Dolby Digital (AC-3), Dolby Digital Plus (E-AC-3), DTS or Dolby TrueHD sound, which browsers can't play, so they'd stream in silence. The host's browser converts that sound itself, without uploading anything: it uses FFmpeg built for the browser (a 32 MB download, only the first time it's needed), converts a minute at a time a few minutes ahead of the picture, and keeps it in sync. Sound starts about a second after the picture, and about two seconds after a jump. The host sees "Sound converted from Dolby Digital 5.1" (or similar) on their preview.
- The stream's sound plays on the speaker chosen in settings, like calls.
- **Share your screen or a tab** from a computer. To include sound, share a tab and turn on "Share tab audio".
- Nothing is uploaded: picture and sound go straight from the host's browser to each viewer (through the TURN relay when a direct route is blocked). It starts at once, in HD with stereo sound, and up to `LIVE_MAX_VIEWERS` (default 10) people can watch.
- The stream keeps going while the host looks at other pages, with a "Live in…" bar to get back. It survives a short connection drop, ends when the host closes the tab, and ends after 15 seconds if their connection doesn't come back. Any admin can stop it.

**Sync and control:**

- Only admins can find, play, pause, seek, change or stop, and the server enforces this.
- The admin who last controlled playback is the host. Every member's player compares itself with the shared timeline every 2 seconds and catches up if it drifts. Late joiners start at the current point.
- Members get volume, mute and full screen. If their browser blocks autoplay, they see **Click to watch along**.
- It won't play DRM-protected video (Netflix, Prime Video and similar), get past logins or bot checks, or fetch anything on the server's own machine or network. Each of these is explained when it happens.

### Design

Two themes, each with its own colours and style. Switch with the sun or moon button on the rail, or from the account menu; your choice is remembered.

- **Midnight Aurora (dark, the default):** a deep navy background, a violet-to-pink "aurora" gradient for the brand, your messages and main actions, and cyan for anything live (online, speaking, streaming). Panels are frosted glass over a soft glow, and the navigation rail is night blue.
- **Ocean Mint (light):** crisp white and pale-blue surfaces, a teal-to-blue ocean gradient, navy text, and mint green for anything live. Panels are flat white with hairline borders and soft shadows, and the navigation rail is light.
- The logo, the browser tab icon and the phone's address bar take on the theme's colours.
- On computers the app is three floating panels: the navigation rail, the list and the conversation. On phones the list and conversation fill the screen, and the navigation floats at the bottom.
- Fonts are Plus Jakarta Sans for text and Sora for headings.

## Host admin

The person running the site logs in as **`admin` / `admin`** and gets an **Admin** tab. This account is created on first start.

- **Overview:** people and who's online, rooms, today's messages, who's in voice or on a call, videos playing, files shared, sign-ups and messages over the last 14 days, and server uptime and memory. It refreshes every 15 seconds.
- **People:** search and filter (online, host admins, switched off). You can:
  - make someone a host admin (their Admin tab appears at once),
  - set a new password for someone who forgot theirs,
  - switch an account off (they're logged out with a reason and can't log back in),
  - add a person by hand, or remove an account with its messages and rooms.
- **Rooms:** every room with its owner, members, messages, who's in voice and what's playing. Stop a video or live stream, or delete a room (its members are told).
- **Site settings:** close sign-ups (the sign-up page then says so, and only a host admin can add people), and post an announcement banner that everyone sees live and can dismiss.
- The site always keeps at least one host admin, and you can't demote or switch off yourself.

**About the default password.** `admin` / `admin` is the first thing anyone would try, so:

- Until it's changed, the Admin pages show a warning. A password of `admin`, or anything under 8 characters, always counts as a default.
- On a production server (`NODE_ENV=production`), the app asks for a new password before anything else, and the admin API refuses to work until then.
- To start with your own login, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `server/.env` before the first start.
- Locked out? Run `npm run admin:reset`. It sets the login back to those values, or `admin` / `admin`.

## Configuration

Settings live in two files, created from their examples. Both `.env` files are excluded from git.

| File | Read by | Holds |
|---|---|---|
| `server/.env` | `server/src/config.js` | Everything the server needs (see below) |
| `client/.env` | `client/vite.config.ts` | `CLIENT_PORT` (dev server port) and `API_URL` (where the dev server forwards `/api` and `/socket.io`) |

Server settings:

| Setting | What it does |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs login cookies. Use a long random string (`openssl rand -hex 32`); in production the server won't start with the example value or anything under 32 characters |
| `PORT`, `NODE_ENV` | API port (and in production, the whole app); `production` turns on secure cookies and the admin password lock |
| `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN` | Cloudflare Realtime TURN key for calls, voice and live streams |
| `FORCE_TURN_RELAY` | `true` sends all media through TURN, which hides people's IP addresses from each other |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Another TURN server instead of Cloudflare |
| `YTDLP_PATH`, `FFMPEG_PATH` | Custom tool paths (the setup scripts install them to `server/bin/`) |
| `DEEP_SCAN` | Open pages in a hidden browser when nothing else finds a video (default `true`) |
| `STREAM_ALLOW_PRIVATE` | `true` lets the relay fetch from your own network, for example a NAS |
| `STREAM_CACHE_GB`, `STREAM_CACHE_DIR` | Disk cap and folder for the shared download |
| `STREAM_CONNECTIONS` | Most parallel connections per relayed file (default 4, 1 = off) |
| `LIVE_MAX_VIEWERS` | Most viewers of a live stream from a device (default 10) |
| `UPLOAD_DIR`, `UPLOAD_MAX_MB` | Where attachments are kept and the largest upload (default 25 MB) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The host admin login created on first start (default `admin` / `admin`) |
| `TRUST_PROXY` | Which proxies may report the visitor's address (default: one on the same machine, like nginx; set `1` if your proxy runs elsewhere) |
| `ALLOWED_ORIGINS` | Extra web addresses allowed to use the app, only if it's reached under a different address than it runs on |

To change the API port, change `PORT` in `server/.env` and the port in `API_URL` in `client/.env` to match. Values set in the shell override both files. Only `VITE_`-prefixed variables in `client/.env` reach browser code, so never put secrets there.

## Production

```sh
npm run build                  # builds client/dist
NODE_ENV=production npm start  # serves the app and the API on PORT
```

Then log in as `admin` / `admin` straight away and choose a new password.

**Keep it running with PM2.** `ecosystem.config.cjs` runs one server process in production mode. Edit its `cwd` and `interpreter` paths for your machine, then:

```sh
pm2 start ecosystem.config.cjs
pm2 save
```

Run a single process: calls, voice and live streams are coordinated in the server's memory.

**Put it behind HTTPS.** Browsers only allow the microphone and camera on HTTPS (or localhost). The proxy must forward WebSocket upgrades for `/socket.io` and accept uploads as large as `UPLOAD_MAX_MB`. An nginx example:

```nginx
server {
    server_name adda.example.com;
    client_max_body_size 25m;          # match UPLOAD_MAX_MB

    location / {
        proxy_pass http://127.0.0.1:4080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }

    location /api/stream/ {            # relayed videos: pass bytes straight through
        proxy_pass http://127.0.0.1:4080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    # listen 443 ssl; plus your certificate lines (for example from certbot)
}
```

**Set up TURN.** Calls use [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/) for networks that block direct connections. Set `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` in `server/.env`.

- The server uses that key to request 24-hour TURN credentials and caches them. The key itself never reaches the browser.
- Calls connect directly when they can, and fall back to Cloudflare's relay over UDP, TCP or TLS on ports 3478, 5349, 443 and 80.
- To use another TURN server, leave the Cloudflare keys empty and set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`.

**Compression:** the built app includes the 32 MB sound converter, which compresses to about 10 MB. Turn on gzip for it in your proxy (in nginx: `gzip on; gzip_types application/wasm application/javascript text/css;`). Built files are cached by browsers for a year, so each person downloads it at most once.

**Back up** the database and the attachments folder (`server/uploads`, or `UPLOAD_DIR`) together.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API and app with live reload (ports 4080 and 5180) |
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Starts the server (serves `client/dist` when it exists) |
| `npm run db:migrate` | Applies the database schema (also done on every start) |
| `npm run setup:yt-dlp` | Downloads yt-dlp to `server/bin/` and checks its checksum. Re-run now and then; sites change. |
| `npm run setup:ffmpeg` | Downloads a static FFmpeg to `server/bin/` and checks its checksum |
| `npm run admin:reset` | Puts the host admin login back to `ADMIN_USERNAME` / `ADMIN_PASSWORD` (or `admin` / `admin`) |
| `npm run test:*` | Browser tests, see below |

## Tests

The tests drive real browsers with Playwright. Start `npm run dev` first, and run `npx playwright install chromium` once if Chromium isn't installed. Screenshots are saved to `tests/screenshots/`.

| Command | What it checks |
|---|---|
| `npm run test:e2e` | Sign-up and login errors; chat with typing and read ticks; voice calls with mute, hang-up and decline; a video call with real frames both ways, camera off/on and switching microphone mid-call; rooms with add, invite and the member limit; three-way room voice; removing a member; the themes. It also checks the TURN relay with a relay-only connection. |
| `npm run test:attachments` | A large photo shrunk and delivered live; a file that only downloads; video in the chat; paste and drag; voice messages; replies and reactions; retrying a failed upload; the size limit; history after reload; files private to their chat or room; the phone's press-and-hold menu. |
| `npm run test:watch` | Admin-only control; play, pause and seek in sync; drift correction; late joiners; YouTube; finding videos on real pages (Wikimedia Commons, a JavaScript player, Bilibili's separate picture and sound); relay fallback; clear refusals for DRM, pages without video and private addresses. Needs internet. |
| `npm run test:find` | Offline: video lengths (MP4, WebM, streams, live), preview clips next to the real video, downloads in small pieces, sites that limit each connection or allow only one, jumps ahead, and joining picture and sound with FFmpeg. |
| `npm run test:live` | Streaming a file from a device to a computer and a phone with stereo sound; a movie with Dolby Digital 5.1 sound converted in the host's browser and heard by viewers, in sync after a jump; pause and seek for viewers; the host browsing away; a viewer reloading; a short connection drop; screen sharing in full sharpness; stopping, refusing members, closing the tab, and timing out. |
| `npm run test:receipts` | One tick to someone offline, two ticks the moment they come back (for every waiting message), two at once when they're online, coloured when they open the chat; message info times; "Last seen just now" and back to "Online"; read receipts off (the sender only sees delivered, both ways, even after a reload); last seen hidden (no status either way, and the API doesn't reveal it); room ticks and "Seen by", room message info and member status; a faked read-ahead and someone else's message info refused. |
| `npm run test:security` | Logged-out access; forged login cookies; requests and live connections from other websites; security headers; outsiders reaching other people's rooms, chats and files; members running a room; admin pages; relay links; signing out other sessions after a password change; bad input to every endpoint (no 500s); all 30 live events × 9 kinds of garbage (the server stays up); message limits and flooding; HTML and scripts in messages, names and rooms showing as plain text. |
| `npm run test:admin` | The `admin` / `admin` login; the Admin tab and API only for host admins; the overview; roles, switching accounts off and on, new passwords, adding and removing people; deleting rooms; closing sign-ups; announcements; changing your own password; the admin pages on a phone. The admin must still have its default password (`npm run admin:reset`). |

## Project layout

```
server/src/
  index.js              Express + Socket.IO entry; serves client/dist in production
  schema.sql            Tables (applied on start)
  routes/               REST: auth, users, chats, rooms, invites, uploads and files, video relay
  routes/admin.js       The host admin API: overview, people, rooms, settings
  services/             Rooms and member limits, attachments, message extras, site settings, TURN
  socket/               Realtime: chat, typing, read receipts, calls, room voice, watch together
  socket/live.js        Live streams from a device: who hosts, who watches, connection setup
  stream/               Finding videos, the relay, the shared download, joining picture and sound
client/src/
  pages/                Sign-in, chats, rooms and the admin pages
  components/           Message list, composer, calls, voice table, watch together, UI kit
  store/                Zustand stores: auth, chat, call (1:1 WebRTC), voice (room mesh), live streams
  realtime.ts           Socket events into the stores
tests/                  Playwright browser tests and their video clips
docs/                   The logo and README screenshots
```

**Stack:** React 19, Vite 7, TypeScript, Tailwind CSS 4, Zustand and React Router 7 on the client; Node.js, Express 5 and Socket.IO 4 on the server; PostgreSQL; WebRTC for calls, voice and live streams.

## Security

- **Logins:** passwords are hashed with bcrypt. Logins use an httpOnly, SameSite login cookie signed with `JWT_SECRET` (only HS256 is accepted). Sign-in and sign-up are rate-limited, and a sign-in takes as long for an unknown email as for a wrong password, so it can't reveal who has an account.
- **Sessions:** changing your password signs you out everywhere else; a host admin setting a new password for someone signs them out everywhere. Switched-off accounts are refused at once, including their live connection.
- **Other websites:** requests that change something, and live connections, are refused when the browser says they come from another site (`Sec-Fetch-Site`, or `Origin` on older browsers). Pages can't be framed by other sites (clickjacking), and the built app sends a content security policy that only allows its own scripts (plus YouTube's player).
- **Private data:** rooms, their messages and files are only served to members; chats only to the two people in them; the admin API only to host admins. A message is always sent as the person whose login sent it.
- **Files:** a file's type is decided from its contents, not its name, so only real photos, videos and audio show inside the page; everything else (including SVG and HTML) is only downloaded, with a sandboxing content policy.
- **Input:** every endpoint validates its input and answers bad input with a clear error. Every live event is guarded, so no payload can crash the server, and messages and reactions are rate-limited against flooding. Queries are parameterised throughout.
- **Fetching links:** the server fetches pasted links itself, so it blocks private and local addresses (localhost, your LAN, cloud metadata) on every request, redirect, yt-dlp request and hidden-browser request. Relay links are signed and only work for the room's members.
- **Secrets:** the Cloudflare TURN key stays on the server; browsers only get short-lived credentials. The default `admin` password must be changed before the admin API works in production.
- **Checking it:** `npm run test:security` tries all of the above against a running server, and `npm audit` reports no known vulnerabilities in the dependencies.

## Limits to know about

- Videos from web pages are relayed through the server. The site is downloaded from once, but each viewer still uses the server's upload bandwidth. A link found on a page can expire after some hours; if a long session stops beyond the part already downloaded, find the video again.
- Some sites throttle or block servers that download a lot. The relay retries hiccups, but a slow site stays slow.
- Calls, room voice and live streams are kept in server memory, so run a single server process. Restarting it ends any calls in progress.
- **Room voice:** each person sends audio directly to every other person, which is why voice is capped at 12 people.
- **Live streams from a device:** the host's computer sends a separate copy to every viewer, up to about 2.5 Mbps each, so 10 viewers need about 25 Mbps of upload. On a slower connection the picture gets softer rather than stopping. For bigger audiences, use a link, which the server relays.
- **Streaming a file needs Chrome, Edge or Firefox.** Safari, which includes every iPhone browser, can't capture a playing video, but iPhones can watch. Phones can't share their screen, and should keep the browser in front while streaming.
- **Attachments** are stored on the server's disk, up to 25 MB each by default. Files picked but never sent are removed after a day.
- Any logged-in person can search for every other person by name or email.
