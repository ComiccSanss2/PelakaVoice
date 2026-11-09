# PelakaVoice

**Voice chat, multi-streaming and private calls for you and your friends — self-hosted, no accounts, no subscriptions.**

PelakaVoice is a Windows desktop app in the spirit of Discord, built for small friend groups.
One person hosts a server with one click, everyone else joins with a short invite code.
Voice and streams go directly between players (peer-to-peer), so the experience stays fast.

---

## ✨ Features

**Voice**
- Crystal-clear voice in user-created lobbies (public or password-protected)
- Headset anti-bleed noise gate, noise suppression and echo cancellation
- Per-person volume up to 200%, remembered for each friend
- Push-to-talk with any key, global mute/deafen hotkeys that work inside games
- Voice effects: Robot, Chipmunk, Deep, Radio, Cave

**Streaming**
- Several people can go live at the same time, and you can watch several streams at once
- Up to **1080p / 60 fps**, hardware-encoded (H.264) and adapted automatically to ping, packet loss and CPU
- **Stream sound** (games, videos, music) without your friends' voices, with its own volume slider
- A stream is only sent to the people who are watching it, to save upload bandwidth

**Social & fun**
- Lobby chat with history, @mentions, clickable links and typing indicators
- Friends list with private messages, 1-on-1 calls and MSN-style nudges 📳
- Shared soundboard: anyone can upload an .mp3 (cut to 5 or 10 seconds) that everyone in the lobby hears
- Emoji reactions, dice, coin flip, "spin the wheel" and live polls

**Quality of life**
- One-click hosting from inside the app (with a Cloudflare tunnel, no port forwarding)
- Keeps running in the system tray while you host or are in a call
- Automatic updates inside the app, Discord-style
- Four themes (Nova, Cupertino, Midnight, Aurora), desktop notifications, recent servers, call timer

---

## ⬇️ Download & install

1. Go to the [**Releases**](../../releases/latest) page and download `PelakaVoice-Setup-x.y.z.exe`.
2. Double-click it. PelakaVoice installs itself and opens — no setup wizard.
3. If Windows shows *"Windows protected your PC"*, click **More info → Run anyway**.
   The installer is not code-signed yet, so Windows doesn't recognise it.

**Requirements:** Windows 10 or 11 (64-bit). Stream sound needs Windows 10 version 2004 or newer.

You only download the installer once: after that, updates are installed from inside the app.

---

## 🚀 Getting started

### Join a friend's server
1. Open PelakaVoice, pick a nickname and an avatar color.
2. Paste the **invite code** your friend sent you (e.g. `four-random-words`) and press **Join PelakaVoice**.
3. Pick a lobby in the list on the left, or create your own with **+**.

> Tip: if the invite code is already in your clipboard, PelakaVoice offers to paste it for you.

### Host your own server
1. Open **Settings → Your server → Host online**.
2. After a few seconds an invite code appears (top right, bottom of the lobby list and in Settings). Click it to copy it, then send it to your friends.
3. Optional: set **When PelakaVoice starts → Host online automatically**, and turn on **Start PelakaVoice with Windows**.
   Your server is then always on while your PC is on, even with the window closed (it lives in the tray).

> The invite code changes every time the server restarts (app or PC restart).
> Want a fixed address that works even when your PC is off? See [Always-online server](#-always-online-server-optional).

### Go live
Inside a lobby, press **Go live** in the bottom bar, choose the quality (1080p 60 fps, 1080p 30 fps for text, 720p 60 fps for slower internet), keep **Share sound too** checked if you want the audio, then pick a screen or window.

---

## ⌨️ Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl + Shift + M` | Mute / unmute — works even inside games |
| `Ctrl + Shift + D` | Deafen / undeafen — works even inside games |
| `M` / `D` | Mute / deafen (app focused) |
| Push-to-talk key | Space by default, change it in Settings |
| `1` … `9` | Play soundboard sounds in a lobby |
| `F` | Fullscreen the first stream you're watching |
| `Esc` | Close windows and menus |

---

## 🛠️ How it works

```
 Friend A ─┐                                        ┌─ Friend B
           │  signaling, chat, lobbies (socket.io)  │
           └──────►  PelakaVoice server  ◄──────────┘
                     (inside the host's app,
                      exposed by a Cloudflare tunnel)

 Friend A ◄═══════ voice + streams (WebRTC, peer-to-peer) ═══════► Friend B
```

- **App:** [Electron](https://www.electronjs.org/). The interface is plain HTML/CSS/JS, without a framework, to keep the app light.
- **Server:** a small Node.js server (plain `http` + [socket.io](https://socket.io/)). It manages lobbies, friends, chat, the soundboard, polls and WebRTC signaling. Everything is kept **in memory**: when the server stops, lobbies and chat history are gone.
- **Internet access without port forwarding:** the host's app starts a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (`cloudflared` is downloaded automatically the first time). The invite code is simply the tunnel name: `four-random-words` → `https://four-random-words.trycloudflare.com`.
- **Voice and streams:** WebRTC in a mesh (each participant connects directly to every other one). Media is encrypted by WebRTC (DTLS-SRTP) and does not pass through the server.
  - The voice is cleaned by a noise gate running in an `AudioWorklet` (audio thread, almost no CPU), and voice effects run the same way.
  - Streams use H.264, which the graphics card encodes and decodes in hardware.
  - Every 2 seconds the sender reads the connection stats (ping, packet loss, CPU) and lowers or raises bitrate, frame rate and resolution for each viewer.
- **Stream sound without voices:** on Windows the app captures the system audio *excluding PelakaVoice itself* (Chromium's `loopbackWithoutChrome` mode), so the call's voices never end up in the stream.
- **Soundboard:** clips are cut to 5 or 10 s in the app and encoded to Opus with WebCodecs (~40–80 KB each). The server stores them per lobby, and when someone presses a sound, every client plays it locally.
- **Updates:** [electron-updater](https://www.electron.build/auto-update) with a "generic" feed.
  - **Who serves them:** the server serves the update files itself (`/updates/latest.yml` + installer), so whoever hosts also distributes the updates.
  - **At launch:** the app checks every recent server in parallel and installs silently from the splash screen.
  - **While open:** the update downloads in the background and a *Restart now* popup appears.

---

## 🌍 Always-online server (optional)

The server can also run 24/7 in the cloud, with a fixed address and without your PC.
The repository includes a ready-made [`render.yaml`](render.yaml) for [Render](https://render.com) (free plan):

1. Push this repository to GitHub.
2. On Render: **New → Blueprint**, pick the repository, then **Apply**.
3. You get a permanent address like `https://pelakavoice-server.onrender.com`. Friends paste it once instead of an invite code.

Notes:
- The free plan sleeps after 15 minutes without anyone connected, and the first person to join waits about a minute.
- App updates are not served from Render, because the installer is too big for the repository. Attach the installer to a GitHub Release and set `pelaka.updateUrl` in `package.json` to `https://github.com/<you>/<repo>/releases/latest/download`.

You can also run the server on any machine with Node.js 18+:

```bash
cd server
npm install
node server.js            # local / LAN, port 3000 (PORT env var to change it)
node online-server.js     # + Cloudflare tunnel, prints the invite code
```

Optional TURN relay for very strict networks: set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` on the server.

---

## 🧑‍💻 Build from source

Requires [Node.js](https://nodejs.org/) 18+ on Windows.

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
npm start          # run the app in development
npm run build      # build the installer into dist/
```

### Publish an update
```bash
npm run release -- 2.3.2 "What changed in this version"
```
or double-click `PUBLISH-UPDATE.bat`. This bumps the version, builds the installer and copies it into `server/updates/` and `%APPDATA%\PelakaVoice\updates\`.
Everyone who connects to your server then receives the update automatically.

### Project structure
```
src/
  main.js            Electron main process: windows, tray, hosting, updates, screen capture
  updater.js         in-app update logic (electron-updater)
  preload.js         safe bridge between the UI and the main process
  renderer/          the interface
    app.js           login, lobbies, friends, calls
    webrtc.js        peer connections, adaptive streaming
    audio.js         microphone pipeline, per-user volume, output device
    gate-worklet.js  noise gate + voice effects (AudioWorklet)
    soundboard.js    clip cutting, Opus encoding/decoding, playback
    stage.js         stream tiles, home screen, call timer, nudges
    fun.js / qol.js  reactions, games, polls / settings, shortcuts, notifications
    host.js          hosting UI, recent servers
    *.css            themes (style.css, nova.css) and layout (layout.css)
server/
  server.js          signaling + lobbies + chat + soundboard + update feed
  tunnel.js          Cloudflare quick tunnel helper
  online-server.js   command-line server with tunnel
scripts/
  publish-update.js  build + publish an update
```

---

## 🔒 Privacy

- No accounts, no analytics, no external servers apart from the Cloudflare tunnel of whoever hosts.
- Voice and streams travel directly between participants, encrypted by WebRTC.
- Chat messages, soundboard clips and lobbies go through the host's server and only live in its memory.
- Your nickname, friends list and settings are stored locally on your PC.

## ⚠️ Known limitations

- Windows only for now.
- Mesh networking: whoever streams uploads one copy per viewer (~8 Mbps each at 1080p60, lowered automatically if needed). Best for small groups.
- Stream sound includes *all* sound from the streamer's PC except PelakaVoice (e.g. music playing in the background).
- Without a fixed server address, the invite code changes whenever the host's server restarts.

## 📄 License

MIT
