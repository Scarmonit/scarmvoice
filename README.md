# ScarmVoice

A desktop voice-chat client for the scarmonit.com message board — the
`/messageboard` page rebuilt as a native Windows app.

> Formerly "The Lounge". The rename changes `productName`, which changes
> `app.getPath('userData')` — so `store.migrateLegacyProfile()` adopts the old
> profile on first run. It copies **`Local State` as well as** `settings.json`
> and `session.bin`: Chromium's `safeStorage` key is per-profile and lives in
> `Local State`, so copying the encrypted session alone produces a file the new
> profile cannot decrypt, silently signing the user out. It must run before
> Electron initialises, which is why main.js calls it at module scope.

It talks to the **same backend as the website**, so desktop and browser users
share one room: the same channels, the same message history, and the same voice
call. Anyone with the board password can run it.

```
┌──────────────┬────────────────────────────────┐
│ CHANNELS     │  # general                     │
│  # general   │  ┌──────────────────────────┐  │
│  # random  ③ │  │  message history          │  │
│              │  └──────────────────────────┘  │
│ VOICE        │  Ava is typing…                │
│ 🔊 Lounge  2 │  ┌──────────────────────────┐  │
│  ● Ava       │  │ Message #general      ➤  │  │
│  ● you       │  └──────────────────────────┘  │
│ [ Join Voice]│                                │
│ ─────────────│                                │
│ 🅟 you 🎙 🎧 ⚙│                               │
└──────────────┴────────────────────────────────┘
```

## Running it

Grab **`ScarmVoice.exe`** (a portable build — no install, no admin) and
double-click. On first launch enter the board password and pick a display name.
The session is remembered for 30 days.

`ScarmVoice-<version>-setup.exe` is the installer version if you'd rather have a
Start-menu entry and desktop shortcut.

## What it does

**Voice**
- Cloudflare RealtimeKit SFU — the same room the website joins
- Open mic or push-to-talk, with a **global** PTT key that works while the app
  is in the background (keyboard keys or mouse side-buttons)
- Mute, deafen, and per-person local volume (0–200%) and mute, remembered
  between sessions
- Live speaking indicators
- Microphone and speaker selection, echo cancellation / noise suppression /
  AGC toggles

**Chat**
- Channels with unread badges; create, rename, delete
- Full history with infinite scroll, day separators, and message grouping
- **Search** across the whole archive (Ctrl+F), scoped to this channel or all
  channels, with highlighted matches and click-to-jump
- **Pin / unpin** messages, a pinned tag in the feed, and a pinned panel per
  channel — the same `pinned` column the website uses, so pins are shared
- **Message actions** via hover menu or right-click: copy (any message), and
  edit / delete on your own only — edit is an inline editor (Enter saves,
  Shift+Enter newlines, Esc cancels) and delete asks first
- **Image lightbox** — click any posted image to expand it; close with the X,
  Esc, or a backdrop click. Right-click the expanded image for Download image /
  Copy image (real bitmap to the clipboard) / Save image as…
- **YouTube previews** — thumbnail, title and channel with a play overlay, for
  `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/` and `m.`/`music.`
  hosts, ignoring any `&t=`/playlist/tracking params. Clicking opens the video in
  your browser, consistent with every other link in the app
- **Link previews** — Open Graph cards (thumbnail, title, description, site)
  fetched through the server's cached unfurl endpoint
- **Inline audio** — mp3/wav/ogg/m4a/flac/webm get a themed player (play/pause,
  seek, elapsed & total, volume) with the filename and a download link. Never
  autoplays, and starting one clip stops any other
- **Attachments stage before sending** — the attach button, drag-and-drop
  (including folders) and clipboard paste all funnel through one path, showing
  removable chips above the composer
- Emoji reactions, quoted replies, thread reply counts
- Image, video, and audio attachments render inline; upload by button, drag-drop
  or paste
- Typing indicators
- Live updates over a WebSocket, with HTTP polling as an automatic fallback

**Sounds** (same assets as the website, `src/renderer/sounds/`)
- Join / leave chimes, armed only while you're in the call and with a 1.5 s
  settle window so the people already there don't each chime
- New-message chime, decoded through Web Audio with an id watermark so a message
  chimes exactly once even when the poll and socket both see it
- Both independently toggleable in Settings

**Desktop**
- **Launch on system startup** (off by default) with a companion **Start
  minimized to the tray**, driven by `app.setLoginItemSettings`; the toggle
  reads the real OS state on open, so it's correct even if changed elsewhere
- **Resilient realtime** — the socket runs a ping/pong liveness check that
  detects a half-open connection (the classic "minimized to the tray for an
  hour, messages stopped appearing" failure) and reconnects with backoff; the
  window shows **Reconnecting… / Disconnected**, and restoring from the tray or
  waking from sleep force-verifies the socket and resyncs missed messages
- Adjustable chat font size — Small / Medium / Large / Extra Large, with
  **Ctrl +**, **Ctrl −**, **Ctrl 0**. One CSS variable drives it, so message
  text, usernames, timestamps and avatars scale together
- Remembers window size, position and maximised state; a saved position that no
  longer lands on any display (monitor unplugged, resolution changed) falls back
  to centred defaults instead of restoring off-screen
- System tray with mute / deafen / join / leave, and close-to-tray so hitting
  the X never drops you from a call
- Desktop notifications when the window isn't focused, preferring an @mention of
  your display name over the newest message — matching the website's rule
- Remembers window size and position

## Development

```bash
npm install         # also vendors the RealtimeKit SDK and generates the icon
npm run dev         # run from source with devtools open
npm run dist        # build both installers and copy the portable exe to the Desktop
```

| Command | What it does |
| --- | --- |
| `npm start` | Run from source |
| `npm run dev` | Same, with devtools |
| `npm run build` | `electron-builder --win` only |
| `npm run dist` | Build **and** drop `ScarmVoice.exe` on the Desktop |
| `npm run vendor` | Re-copy the RealtimeKit browser bundle into `src/renderer/vendor/` |
| `npm run icon` | Regenerate `build/icon.ico` |

## How it's put together

```
src/
  main/          Electron main process — holds ALL credentials
    main.js      window, tray, protocol handler, permissions, IPC
    net.js       authenticated HTTP to the board API
    rt.js        WebSocket bridge to the realtime Durable Object
    ptt.js       global push-to-talk
    store.js     settings + encrypted session storage
    preload.js   the only renderer↔main bridge (contextBridge)
  renderer/      UI — no network access of its own
    app.js       chat, channels, roster, settings
    voice.js     RealtimeKit SFU engine
    vendor/      RealtimeKit bundle, copied from node_modules at install
```

### Why the network lives in the main process

The board's session cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`. The
renderer is loaded from `file://`, which is a *different site*, so a browser-side
`fetch` would never attach the cookie and every `/api/board/*` call would 401.

So the main process owns the credential and sets the header explicitly — which
is both deterministic and immune to SameSite semantics — and the renderer only
ever receives parsed JSON over IPC. The same applies to the realtime WebSocket,
whose upgrade request is gated by the same cookie.

Attachments are the third case: an `<img src="https://scarmonit.com/api/board/file?…">`
would also be uncredentialed, so `main.js` registers a `lounge://` protocol that
proxies those bytes through the authenticated client.

The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
under a CSP that blocks remote script, and is granted only the microphone and
notification permissions.

### Voice settings that are deliberate, not accidental

These match what the website already verified against this SFU:

- `enableHighBitrate: true` gives 64 kbps mono Opus, which is the ceiling for a
  mono source. This SDK has **no** numeric bitrate field, and enabling stereo on
  a mono mic doubles the bytes for zero gain.
- **AGC defaults to off.** Its level loop audibly self-modulates the volume.
- The SDK reads the *misspelled* getUserMedia key `noiseSupression` (one `s`),
  so `voice.js` passes both spellings.
- Participants are keyed by `customParticipantId` (which equals the board's
  client id) rather than the per-session participant id, so per-person volume
  and mute settings survive restarts and match the website's.
- The RealtimeKit SDK is **pinned to 2.0.0** — the version those behaviours were
  verified against — and vendored from `node_modules` instead of a CDN so the
  packaged app has no external script dependency.

### Link previews

Rendering never waits on the network. The message is drawn immediately with a
plain linkified URL, an empty `.msg-previews` container, and the fetch fired off
in the background; when metadata arrives the card is **grafted into the live DOM
node** rather than triggering a re-render, so the reader's scroll position is
never disturbed. Results are cached per URL as `preview | null | 'pending'`, so a
link with no metadata is asked about exactly once and silently stays a plain
link. Direct image URLs skip the round trip entirely and render inline, and a
hotlinked image that fails to load removes itself instead of leaving a broken
icon. `img-src` allows `https:` for the thumbnails, matching the website's CSP.

### Window state and the lightbox

Resize/move fire continuously while dragging, so saves are debounced (400 ms)
and flushed on close; maximise/unmaximise are discrete and save immediately.
`getNormalBounds()` is stored rather than `getBounds()` — otherwise the
maximised rectangle would be persisted and un-maximising later would snap the
window to full-screen size.

The lightbox starts **below** the title bar (`inset: var(--tb) 0 0 0`) rather
than covering the whole window. Electron's `titleBarOverlay` window controls are
drawn by the OS above all web content, so a close button in the overlay's
top-right corner would sit underneath them — ambiguous at best, and one
mis-click from closing the whole app. Starting lower puts the lightbox toolbar
~49 px clear of the controls, keeps the window draggable while an image is open,
and both the overlay and its toolbar are explicitly `-webkit-app-region: no-drag`.

### Realtime liveness (the "tray for an hour" bug)

A WebSocket can go **half-open**: the peer vanishes (sleep, or a NAT/conntrack
entry dropped after a long idle) but no FIN arrives, so `readyState` stays OPEN
forever. Sends still succeed, `'close'` never fires, and no events arrive — the
exact "sent a message after 40 min in the tray, it never showed" report. The old
heartbeat sent an app ping but never checked for a reply, so it couldn't see
this. `rt.js` now runs the documented ws ping/pong pattern: each interval, if the
previous ping got no pong (or any other frame), the socket is declared dead and
**`terminate()`**-d (not `close()`, which can hang on a handshake the dead peer
won't complete), which drives reconnect with backoff.

Three more pieces close the loop: `backgroundThrottling: false` keeps the
renderer's fallback poll running at full rate while hidden; `win.on('restore'/
'show')` and `powerMonitor 'resume'` call `rt.wake()` (which force-pings and
tears down a zombie even when it looks connected) and tell the renderer to
resync; and reconnecting fetches the latest window rather than only resuming live
events. The titlebar shows Reconnecting… / Disconnected so the state is never
silent.

> **Portable-build login item.** The portable exe self-extracts to a random
> `%TEMP%` dir each launch, so `process.execPath` is a dead target for a startup
> entry. electron-builder exposes the real path in `PORTABLE_EXECUTABLE_FILE` —
> pass it to `setLoginItemSettings`/`getLoginItemSettings`. And because Windows
> matches a login item by path **and args**, a query with `--openAsHidden` won't
> match an entry written without it; `getLoginItem` reads both signatures and
> merges them, or the checkbox reads back false right after you enable it.

### Attachments and drag-and-drop

Drag-and-drop was silently broken by the navigation guard: it allowed **any**
`file://` URL, so dropping a file navigated the renderer to
`file:///C:/…/dropped.png` and replaced the entire UI. The guard now permits
only a reload of the current URL, and every `dragover`/`drop` calls
`preventDefault()` in the capture phase.

All three input routes — button, drop, paste — call the same `stageFiles()`,
so size (25 MB) and count (10) limits can't be bypassed by picking a different
one. Dropped folders are walked with `webkitGetAsEntry()` (looping
`readEntries()`, which returns at most 100 per call) and keep their relative
path in the filename. Dragging an image out of another browser window gives a
URL rather than a file, so those bytes are fetched in the main process — the
remote host won't send CORS headers.

Nothing uploads until send: staged files are held as `File` handles and read
only at send time, so staging a large file costs no memory.

YouTube's oEmbed endpoint sends no `Access-Control-Allow-Origin`, so that fetch
also lives in the main process, cached per video id (24 h on success, 5 min on
failure so a transient error recovers but a deleted video isn't re-fetched every
render).

### Editing

The inline editor has to survive the background poll — `renderMessages()` rebuilds
the whole list, which would rip a half-typed edit out from under you, so it
returns early while an edit is open and resyncs when the edit finishes. A failed
save keeps the editor open with your text intact rather than discarding it.

### Push-to-talk

Electron's `globalShortcut` only reports key *presses*, never releases, so it
cannot drive real push-to-talk on its own. The app uses the optional native hook
`uiohook-napi` (prebuilt, no compiler needed) for true system-wide
keydown/keyup. If that module is unavailable it degrades gracefully: the
accelerator becomes a push-to-talk *toggle*, and hold-to-talk still works
whenever the window has focus.

### Screen sharing

Electron on Windows has no system picker, so the app shows its own: screens and
windows with live thumbnails, plus a system-audio toggle (Windows loopback).
The source is registered with the main process *before* the SDK is told to
share, because `enableScreenShare()` calls `getDisplayMedia()` immediately and
the display-media handler needs an answer ready.

Quality uses the same tiers as the website — 720p/1080p/1440p × sharp/smooth —
and the same encoder-pinning trick: RealtimeKit exposes no screen-share bitrate
API and its default cap silently downscales the share to ~720p, so `voice.js`
wraps `RTCPeerConnection` to keep a registry of peer connections and calls
`setParameters` on the real sender.

> **CSP footgun (fixed 2026-07-23).** The website loaded the RealtimeKit SDK
> from jsDelivr while its own CSP was `script-src 'self' 'unsafe-inline'`. The
> SDK was blocked, `sfuJoin()` rejected, and the `.catch()` silently fell back
> to the mesh engine — so browsers were on mesh while this app was on the SFU
> and no media could flow between them. It stayed hidden because the voice
> roster merges the D1 presence table with the SFU participant list, and both
> engines heartbeat into that table, so a dead call looked like a live one. The
> SDK is now self-hosted on the site. This app flags a participant who is in
> presence but not an SFU peer with a ⚠ so the mismatch can't hide again.

## Not implemented yet

Carried by the website but not yet ported:

- Webcam video
- Threads — reply counts show, but the thread view doesn't open yet
- Message editing, deleting, pinning, and search
- RNNoise voice isolation (the browser's own noise suppression is used instead)
