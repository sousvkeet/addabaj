# Adda Khana for Android (native)

The Android app, written natively in Kotlin with Jetpack Compose. It replaces the WebView app in [`../android`](../android): it has the same package (`com.addakhana.app`) and the same signing key, so phones get it as an ordinary update from **Admin › App updates**, and people stay signed in across it.

Why native: a web page in a WebView is frozen by Android once it's out of sight and quiet for a minute (WebView 149 on). Room voice and calls then dropped a minute or two after leaving the app or locking the phone. WhatsApp and Telegram don't have this problem because nothing of theirs runs in a web page. This app is built the same way: the connection to the server, calls, room voice and their sound are all native, in a foreground service, and nothing waits on a page.

## What it does

Everything the web app does, natively:

- **Chats and rooms.**
  - Chats, rooms and invites.
  - Replies, edits, deletes, forwards, reactions, mentions and link cards.
  - Clear chat history (⋮ in a chat): for you, or with "Also clear for them" for both of you, as on Telegram.
  - Photos, files, and voice messages.
  - Read receipts and "Seen by", typing, presence and last seen.
  - Mute, pin and archive.
  - Blocking and reports.
  - Room admin: passwords, invite codes, roles, voice and camera moderation, and chat history clearing (presets or a custom time).
- **Calls ring like phone calls.**
  - A call rings the phone even when the app is closed or killed (a high-priority push), as a call notification with Answer and Decline.
  - On a locked phone the call screen lights up over the lock screen. Answering there connects at once, without unlocking; unlocking only opens the rest of the app.
  - Calls you didn't answer leave a missed-call notification.
- **Room voice, calls and live streams keep going out of sight.**
  - This covers the app in the background, the screen off, and the app swiped away from Recents.
  - It runs as a foreground service (microphone, camera, media playback or screen capture, as needed), with the processor and Wi-Fi kept awake and a notification with Mute and Leave.
  - The app keeps its connection to the server only while something needs it: the app on screen, a call, room voice, or a ringing call. Otherwise it lets go after 5 seconds, so the server sends notifications instead.
- **Arrange the videos however you like** in one-to-one and room video calls. Each person is in the grid, full screen, or in a small floating window:
  - **Full screen:** tap someone, or use their ⋮ › Full screen. The others wait in a row along the bottom, and a tap on the full-screen video hides or shows the buttons. Back (in a room) goes back to the grid.
  - **Floating:** drag a floating window anywhere; it stays clear of the buttons. Press and hold anyone else and drag them out of the grid into one. Tap a floating window to swap it with whoever's full screen, as in WhatsApp.
  - **Switch any time:** press and hold anyone (or tap their ⋮) for Full screen, Small floating window or Back to the grid. The grid button at the top puts everyone back.
  - A one-to-one call starts as WhatsApp's: them full screen, you floating in the corner. Each picture keeps playing while it moves between these (nothing reconnects or goes black), and in rooms each person is asked to send just the size they're shown at.
- **The call over the room's video:** while the room's video plays on its page (or full screen), the call's cameras float over the player instead of the call's screen covering it, and the video plays on. Up to three windows, yours among them (the others: whoever spoke last; the rest counted, and not sent to the phone). Drag a window to move it, or a corner to resize it, each on its own, always inside the player. A bar at the top has the microphone, camera and switch-camera buttons, and **Open the call**; the call's screen has **Show over the video** to go back (`ui/watch/PlayerCalls.kt`).
- **Room calls through LiveKit** when the server has it: each person sends their microphone and camera once and LiveKit passes them on, so rooms stay smooth with many people, on far less data and battery. Admins' mutes and camera stops hold in LiveKit too.
- **Video calls float** in picture-in-picture when you leave the app, with Mute and Hang up. In a room, it shows whoever you made full screen.
- **Watch together.**
  - Files and streams play in ExoPlayer. YouTube plays in YouTube's own player, the only one apps may use.
  - Everyone stays in sync with the room's timeline, and admins drive play, pause and seeking.
  - Up next and the admin's "find videos at a link" work as on the web.
  - The video carries on in a small player around the app, and full screen turns the phone sideways.
  - A file's sound keeps playing in the background. YouTube stops there, as YouTube requires, and catches up when you're back.
- **Live streams.**
  - Watch a stream from a phone or computer.
  - Stream your screen (the picture), or a video file playing on the phone, with its sound. The film's sound goes out in place of the microphone's.
- **Switch where the sound plays, as in WhatsApp:** the sound button in calls, room calls and on the call and voice bars shows where it plays now (loudspeaker, earpiece, Bluetooth, headphones). With only the earpiece and loudspeaker, a tap switches between them; with a headset in too, it opens the list, the one playing ticked. A headset put on during a call takes the sound; taken off, the sound goes back.
- **Noise cancellation**, as in Meet or Zoom: in calls and room voice, background noise (traffic, typing, fans, a television) is taken out of the microphone and voices stay. On unless turned off with its switch in **You** (or in **Audio and video**); it switches at once, mid-call too. A quiet microphone then sends next to nothing, so it saves data as well. A phone too slow for it (cleaning 10 ms of sound taking 5 ms of processor time) turns it off by itself until the app starts again, rather than let the call's sound break up.
- **Audio and video settings** (Settings, and the call screens):
  - where calls sound (earpiece, loudspeaker, Bluetooth, headphones), with a test sound
  - a microphone level meter
  - noise cancellation on or off
  - which camera calls start with, with a preview
- **Uses little data, like WhatsApp** (**You › Storage and data**):
  - **Calls:** voices send next to nothing while nobody speaks, always. **Use less data for calls** (*Off*, *On mobile data* by default, or *Always*; and whenever the phone's Battery Saver is on) also caps voices at 20 kbit/s, and video at about 450 kbit/s and 20 frames a second in calls and 480p in rooms. It asks the other side to send less too, and films in watch together stop at 480p.
  - **Media auto-download**, chosen separately for mobile data, Wi-Fi and roaming: by default photos on mobile data, everything on Wi-Fi, nothing when roaming. Chats show the server's small copies (a photo bubble is about 30 KB). Anything not downloaded shows blurred with its size, and downloads on a tap. Voice messages and videos up to 25 MB download ahead where allowed, so they play at once.
  - **Media upload quality:** *Standard* sends photos at up to 1600 px, and videos at 720p and about 2 Mbit/s (shrunk on the phone, with the progress shown). *HD* sends photos at up to 4096 px, and videos as they are, within the size limit.
  - What you send stays on the phone, so it never downloads back. **Network usage** counts what calls, media and messages sent and received, on mobile data and Wi-Fi, and **Clear** frees what's kept on the phone.
- **Easy on the battery, like WhatsApp:**
  - Out of the app, nothing runs unless a call, room voice or a live stream does: the connection to the server closes a few seconds after you leave, and messages and calls come as push notifications.
  - **A video call out of sight pauses video** (screen off, or another app without the floating window): your camera stops, and the other side stops sending you theirs (each sees the other's photo). Both come back with the call screen. In rooms, your camera stops and nobody sends you video, as before.
  - With the screen off, a call does only what its sound needs: the call screen's clock, speaking rings and "No sound arriving" check stop until it shows again.
  - Room calls through LiveKit leave out LiveKit's call statistics (sent to its server all call long) and its copy of every 10 ms of the microphone (for features the app doesn't use). With the screen off, room voice takes about a third less processor than before (measured on the emulator).
  - Watch together's sync runs only while a video plays. Network usage is counted every 10 seconds on screen, less often out of sight, and saved once a minute.
  - With Battery Saver on, calls use less data, and so less battery (Storage and data shows it).
- **Updates from your own server.** A newer version from Admin › App updates downloads with a progress bar, is checked against its SHA-256, and opens Android's installer.
- **Offline.**
  - Recent chats are kept on the phone.
  - Messages written offline wait and send themselves in order when the connection is back.
- **Site admin** (host admins): overview, people, rooms, reports, site and message settings, email, and app updates.

Works on Android 7.0 and newer (API 24+), targets Android 16 (API 36).

## How it's built

- `Graph` holds what lives as long as the app's process: the cookie jar and HTTP client, the live connection, and the stores.
- **`net/`**
  - `Api` is the REST API.
  - `Realtime` is a small Socket.IO v4 client over OkHttp's WebSocket: Engine.IO 4, websocket transport, with heartbeats, a watchdog and reconnection.
- **`data/`** has the chats store (a port of the web app's `store/chat.ts`), auth, site settings, media, permissions, updates and device settings.
- **`call/`**
  - `CallStore` handles one-to-one calls (phone to phone). `VoiceStore` handles room voice: through LiveKit when the server has it (`LiveKitCall`, with the server's ticket; the server still keeps the seats), otherwise a WebRTC mesh with the web app's signalling and repair rules.
  - `CallService` is the foreground service: audio mode and routing, proximity, and wake locks.
  - `IncomingCallActivity` is the lock-screen call screen.
- **`rtc/`**
  - `Rtc` sets up WebRTC for calls and live streams.
  - `NoiseCanceller` is noise cancellation: WebRTC hands it each 10 ms of the microphone after its own processing (the echo canceller), through `ExternalAudioProcessingFactory`, and it cleans it in place with RNNoise (`Rnnoise`, native). WebRTC has one slot for it, shared by the app's calls and LiveKit's rooms (`AudioProcessorOptions`), and both put this one in it. A film's sound streaming in watch together is left alone.
  - In debug builds, `TestMic` plays a sound file (`files/test-mic.wav`) in place of the microphone, for testing calls on an emulator.
- **`cpp/`** (in `src/main`) is the native code: [RNNoise](https://gitlab.xiph.org/xiph/rnnoise) 0.2 (`rnnoise/`, see its README) and the app's glue (`noise_core.c`, `noise_jni.c`). RNNoise works at 48 kHz; at other rates the glue converts the sound there and back.
- **`watch/`**
  - `WatchStore` keeps watch together in sync, with `Players` (ExoPlayer, YouTube).
  - `LiveStore` handles live streams. `FileSound` copies a file's sound into WebRTC's recording.
- **`push/`** has Firebase messages, notifications (the same channels as the WebView app), and ringing.
- **`ui/`** is Compose: one activity, a small back stack (`Nav`), and the web app's design tokens (`ui/theme`).

Libraries (each at least two weeks old when chosen):

- Compose BOM 2026.06.01
- OkHttp 5.4
- kotlinx.serialization 1.11
- Media3 1.10.1
- Coil 3.5
- LiveKit Android 2.29.0 (room calls). Its copy of WebRTC (144.7559.14, as `livekit.org.webrtc`) is the one the whole app uses, for calls and live streams too, so there's one in the app, not two. One of LiveKit's libraries (`audioswitch`) comes from JitPack, which the build allows for that library only.
- Firebase BOM 34.19
- RNNoise 0.2 (April 2024, noise cancellation), built from source with the NDK. Copyright Jean-Marc Valin, Xiph.Org Foundation, Mozilla and Amazon, under the BSD licence in `app/src/main/cpp/rnnoise/COPYING`.

## Notifications (Firebase)

The same Firebase project as the WebView app: the build reads `../android/app/google-services.json` (see [its README](../android/README.md#turning-on-notifications-firebase)). Without it the app works, but doesn't notify or ring while closed.

## Build

Needs JDK 17 or newer and the Android SDK (platform 36), with the NDK (27.2.12479018) and CMake (3.22.1) for noise cancellation's native code: `sdkmanager "ndk;27.2.12479018" "cmake;3.22.1"`. Set `sdk.dir` in `local.properties` or `ANDROID_HOME`.

```bash
cd android-native
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The server is `addaUrl` in `gradle.properties`; `-PaddaUrl=https://your-server.example` builds for another.

Release builds are shrunk (R8) and carry only the ARM code real phones use (noise cancellation adds about 1.4 MB for each). The keep rules for WebRTC (LiveKit's copy, `livekit.org.webrtc`), whose native code finds its Java classes by name, are in `app/proguard-rules.pro`.

## Signing

Release builds are signed with the WebView app's key, named in `../android/keystore.properties` (see [its README](../android/README.md#signing)). It must be that key: phones only install an update signed like the app they have. Without the file, release builds come out unsigned.

## Publishing a release

1. Raise `versionCode` and `versionName` in `app/build.gradle.kts`. The first native version must be above the WebView app's last (16).
2. Build and check the signature:

   ```bash
   ./gradlew clean assembleRelease
   apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
   mkdir -p dist && cp app/build/outputs/apk/release/app-release.apk dist/AddaKhana-<version>.apk
   ```

3. Upload it in **Admin › App updates** (in the app, or on the site) and publish it on GitHub, as in the [WebView app's steps](../android/README.md#publishing-a-release). `dist/` is ignored by git.

People updating from the WebView app stay signed in: on first start the app takes over the login kept by the old app's web view.

## Testing on an emulator

Debug builds install beside the release app as `com.addakhana.app.dev` ("Adda Khana Dev"), can use a server on your computer, and accept pretend pushes over adb:

```bash
./gradlew installDebug -PaddaDebugUrl=http://localhost:4080
adb reverse tcp:4080 tcp:4080
# a pretend call push:
adb shell am broadcast -n com.addakhana.app.dev/com.addakhana.app.push.DebugPushReceiver --es data \
  "'{\"type\":\"call\",\"callId\":\"<id>\",\"callerId\":\"<user id>\",\"callerName\":\"Ana\",\"video\":\"0\"}'"
```

On an emulator, video decoding and encoding are in software, so YouTube and live streams run at a few frames a second. Phones do it in hardware.

## Limits

- **Phones that stop background apps** (Xiaomi, Huawei, OPPO, Vivo, and Samsung's sleeping apps): the first-start screen offers the settings that let calls ring and voice stay on.
- **Screen sharing** sends the picture, not the phone's sound.
- **A video file's sound in a live stream** goes out through WebRTC's recording. So it needs the microphone permission (the microphone's own sound is replaced, not sent), and it can't play while you're in a call or room voice.
- **Updates** need one tap on Android's installer.
