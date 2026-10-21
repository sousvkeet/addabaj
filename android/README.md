# Adda Khana for Android

A native app that shows the Adda Khana site full screen in Android's WebView and adds what a messenger needs on a phone. The chats, rooms and calls themselves are the live web app, so server updates reach the app without a new APK.

What the app adds:

- **Notifications while the app is closed.**
  - New messages arrive as one notification per chat or room, with the latest messages and each sender's picture: their profile photo (kept on the phone after the first download), or their initials.
  - Reply and Mark as read work right from the notification.
  - Several waiting chats are bundled together.
  - Reading a chat anywhere (phone, computer) clears its notification.
  - The phone stays quiet while you're using Adda Khana on it or on a computer.
- **Calls ring like phone calls.** Someone calling you rings the phone with your ringtone even when the app is closed. The call screen appears over the lock screen with the caller's photo, Answer and Decline. Calls you didn't answer leave a missed-call notification.
- **Calls keep going in the background.**
  - Calls, room voice and live streams keep running with the screen off or another app open. A notification shows the call, its length and a hang-up button.
  - Swiping the app away doesn't end the call.
  - Voice calls play from the earpiece, and the screen turns off at your ear. The speaker button switches to the loudspeaker. Video calls and rooms use the loudspeaker; a headset takes over when plugged in.
- **Screen sharing.** "Share screen" in a live stream works on the phone: Android asks for permission, then everyone watching sees your screen, including while you use other apps. Picture only; the phone's sound isn't shared.
- **Room invite links** (`https://<your server>/join/…`) open straight in the app. Share buttons (your user ID, a room's invite link) use the phone's share sheet: WhatsApp, Messenger, SMS and so on.
  - This works because the server publishes `/.well-known/assetlinks.json` with the app's signing key fingerprint. Android checks it when the app is installed.
  - It's set for the key in `android/keystore`. If you sign with another key, set `ANDROID_CERT_SHA256` in `server/.env`.
- **Updates from your own server.** When the host uploads a new version (Admin › App updates), the app offers it the next time it opens. **Update app** downloads it with a progress bar, checks its SHA-256, and opens Android's installer. Mandatory versions can't be put off. See [Publishing a release](#publishing-a-release).
  - The first time, Android asks to allow installing apps from Adda Khana (Settings › Install unknown apps); the update carries on once you come back.
  - The app only downloads from its own server's `/api/app/download/<version>` address, and only opens a file whose SHA-256 matches the release.
- **Feels like an app, not a website.**
  - Tabs along the bottom, Settings under You, and a round button for a new chat or room.
  - Screens slide in and out, also with Android's back gesture; forms slide up from the bottom and swipe down to close.
  - Back works like WhatsApp's: it closes what's open first (a form, a photo, a message's menu), then goes back to the list, then to Chats, and only leaves the app from Chats, keeping it running in the background. A chat opened from a notification goes back to Chats as well (1.6.1 on: the page steps through its own screens, because the WebView's Back skips screens the page added by itself).
  - Press and hold a message for its menu (with a buzz), swipe it right to reply, and pinch or double-tap photos.
  - The phone's font, press ripples, and no accidental zooming or text selection. Dialogs from the app itself use the phone's own style.
- **Opens at once, even offline.**
  - Recent chats are kept on the phone, so the app opens straight onto them and catches up in the background. With no connection it still opens, with "Waiting for network…".
  - Messages written offline wait with a clock and send themselves when the connection is back (for up to two minutes; after that they're marked "Not sent" with a retry).
  - Coming back after Android closed the app in the background opens the latest version of the site, never a stale copy.
  - An app left open while you update the server reloads itself the next time it's out of sight (not during a call, voice, a live stream or a message sending), so new features and the update screen arrive without closing it.
- **Everything a browser does.**
  - Microphone and camera for calls.
  - The photo and file picker; downloads go to Downloads.
  - Full-screen video.
  - The back button steps through screens (see above).
  - Links to other sites open outside.
  - An offline page that reconnects by itself.
  - Bars in the app's light or dark colours.

Works on Android 7.0 and newer (API 24+), targets Android 16 (API 36). HTTPS only.

## Turning on notifications (Firebase)

Notifications go through Firebase Cloud Messaging (FCM), as with most Android messengers. It's free. Without it the app works fully, but doesn't notify or ring while it's closed.

1. In the [Firebase console](https://console.firebase.google.com/), create a project (Google Analytics isn't needed).
2. **The app:** add an Android app with the package name `com.addakhana.app`. Download its `google-services.json` into `android/app/`, then build the APK (below).
3. **The server:**
   1. Open Project settings › Service accounts › Generate new private key.
   2. Put the downloaded JSON file on the server (outside the web folder, readable only by the server's user).
   3. Set `FCM_SERVICE_ACCOUNT=/path/to/that-file.json` in `server/.env`, and restart. The log says `Push notifications: on`.

Both files are ignored by git. The service account key is a secret: anyone with it can send notifications to your users.

Message previews pass through Google's servers on the way to the phone, as with other apps that use FCM.

## Build

Needs JDK 17 or newer and the Android SDK (platform 36, build-tools 36). Set `sdk.dir` in `android/local.properties` or `ANDROID_HOME`.

```bash
cd android
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The site the app opens is `addaUrl` in `gradle.properties`. To build for another server without editing it:

```bash
./gradlew assembleRelease -PaddaUrl=https://your-server.example
```

For each new release, raise `versionCode` (and `versionName`) in `app/build.gradle`. Android only installs an update over the old app when the version code is higher.

## Signing

Release builds are signed with the key named in `android/keystore.properties`:

```properties
storeFile=keystore/adda-release.jks
storePassword=…
keyAlias=addakhana
keyPassword=…
```

Both the keystore and this file are ignored by git. **Back them up somewhere safe.** Every update must be signed with the same key, or phones refuse to install it over the old app. Without `keystore.properties`, release builds come out unsigned.

To make a new key:

```bash
keytool -genkeypair -storetype PKCS12 -keystore keystore/adda-release.jks -alias addakhana \
  -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Adda Khana, O=Adda Khana"
```

Check a built APK with `apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk`.

## Install

Ready-made APKs for `https://adda-api.clix.dpdns.org` are on the [releases page](https://github.com/sousvkeet/addabaj/releases/latest). For your own build, copy the APK to the phone and open it (allow "install unknown apps" for the file manager or browser when asked), or with USB debugging on:

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

On first sign-in the app asks to show notifications. On Android 14 and newer it also asks to show calls full screen; that setting is what lets calls ring over the lock screen.

## Publishing a release

1. Raise `versionCode` and `versionName` in `app/build.gradle`. Phones compare `versionCode`, so it must go up every time.
2. Make sure `app/google-services.json` is in place (or the release has no notifications).
3. Build and check the signature:

   ```bash
   ./gradlew clean assembleRelease
   apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
   cp app/build/outputs/apk/release/app-release.apk dist/AddaKhana-<version>.apk
   ```

4. **Send it to phones:** sign in to the site as host admin, open **Admin › App updates**, choose the APK, write what's new, and **Upload and publish**. Turn on **Make it mandatory** if older versions must stop working (you can also switch that on or off later for any version).
   - The server reads the version and signing key from the file. It refuses a file that isn't newer than the latest upload, is another app, or is signed with a different key than the version before. The first upload must match `ANDROID_CERT_SHA256` (by default the key in `android/keystore`).
   - Apps from 1.4.0 on download and install it themselves. Older apps are offered it too and download it with Android's downloader; tapping its notification installs it.
5. Commit, then also publish it on GitHub for new installs (`dist/` is ignored by git):

   ```bash
   gh release create v<version> dist/AddaKhana-<version>.apk --title "Adda Khana <version>" --notes "…"
   ```

## Testing on an emulator or a phone, without Firebase

Debug builds can open a server on your computer and accept pretend pushes over adb:

```bash
./gradlew installDebug -PaddaDebugUrl=http://localhost:4080
adb reverse tcp:4080 tcp:4080
# a pretend message notification:
adb shell am broadcast -n com.addakhana.app/.DebugPushReceiver --es data \
  "'{\"type\":\"message\",\"scope\":\"dm\",\"chatId\":\"<a user id>\",\"chatName\":\"Ana\",\"senderName\":\"Ana\",\"text\":\"Hi\",\"messageId\":\"1\"}'"
```

`npm run test:push` checks the server side of notifications against a fake Firebase.

**Trying updates with debug builds:** debug builds are signed with your debug key, which the server refuses by default. Set `ANDROID_CERT_SHA256` in `server/.env` to the debug key's fingerprint (`./gradlew signingReport`), clear the uploaded versions in Admin › App updates, install one debug build, then upload a debug build with a higher `versionCode`. `npm run test:updates` checks the server and the update screens (without a phone).

## Limits

- **Phones that stop background apps:** some brands (Xiaomi, Huawei, OPPO, Vivo) stop apps more aggressively than Android does. If calls don't ring there, allow Adda Khana to run in the background (battery settings › no restrictions).
- **Screen sharing:** sends the picture, not the phone's sound.
- **Push notifications** need the Firebase setup above.
- **Updates** need one tap on Android's installer: Android asks you to confirm every app installed from outside an app store. Phones where the owner blocks "Install unknown apps" (some work or school phones) can't update this way.
