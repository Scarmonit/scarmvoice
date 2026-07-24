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
- **Camera** — turn on video in a call; everyone's tiles appear in a strip above
  the message list. Plain RealtimeKit video on the same meeting, so it works
  across desktop and web
- Microphone and speaker selection, echo cancellation / noise suppression /
  AGC toggles

**Presence**
- **Members list** — everyone here, not just the call: online / away, their
  status line, and who's in voice, in one list. People in voice keep the
  per-person volume controls
- **Custom status** — set a status beside your name, shared with the website

**Chat**
- Channels with unread badges; create, rename, delete
- Full history with infinite scroll, day separators, and message grouping
- **Search** across the whole archive (Ctrl+F) via `/api/board/search`, scoped to
  this channel or all channels, with the match highlighted and click-to-jump
  (into the thread, if the hit is a reply). The same box also filters the
  messages already loaded by type, sender, pinned, mentions or edited
- **Message formatting** — `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||`,
  `` `code` ``, ```` ```fenced blocks``` ```` with syntax highlighting, lists and
  blockquotes. Same renderer as the website, so a message reads identically in
  both; see [Formatting is DOM, not markup](#formatting-is-dom-not-markup)
- **Emoji picker** — react with any emoji from the message menu or the hover
  bar, and insert emoji into the composer. Same set as the website
- **Replies and threads** — reply to quote a message above your own, or open a
  thread panel to read and post replies in place. Reply counts on the message
  open the thread
- **@mention autocomplete** — a name picker as you type `@`, over everyone seen
  this session; mentions render as chips, highlighted when they're you
- **Voice messages** — record in the composer and send as an audio attachment
  (opus/webm, same as the website), with elapsed time and discard
- **Pin / unpin** messages, a pinned tag in the feed, and a pinned panel per
  channel — the same `pinned` column the website uses, so pins are shared
- **Message actions** via hover menu or right-click: react, reply, reply in
  thread, copy (any message), and edit / delete on your own only — edit is an
  inline editor (Enter saves, Shift+Enter newlines, Esc cancels) and delete asks
  first
- **Image lightbox** — click any posted image to expand it; close with the X,
  Esc, or a backdrop click
- **Image actions** on right-click — Copy image (real bitmap to the clipboard) /
  Save image as… / Download image / Copy image link. The same menu on the inline
  image in chat and on the expanded one, so expanding first is never required;
  right-clicking the text beside an image still gives the message menu
- **Jump to present** — a floating button appears once you scroll away from the
  bottom, badged with how many messages arrived while you were up there. New
  messages never yank your scroll position, including when images and link
  previews above the viewport finish loading
- **Link actions** on right-click — Open link (in your default browser) and Copy
  link address, on bare URLs in a message and anywhere on a YouTube or Open Graph
  preview card, thumbnail and padding included. Only `http`/`https` is ever
  offered; see [Opening links](#opening-links)
- **Composer menu** on right-click — Cut / Copy / Paste / Select all, greyed out
  when they'd do nothing (nothing selected, empty clipboard). Paste runs as a
  native editing command, so an image on the clipboard stages as an attachment
  exactly as Ctrl+V does
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
- **Auto-update** via electron-updater against GitHub Releases — a non-blocking
  banner shows when a new version is available (with release notes and download
  progress), and an optional "Update automatically" setting downloads in the
  background and installs on quit. Downloads are **differential** (only changed
  blocks), so a point release is a ~1 MB fetch, not the full installer
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
npm run build       # build the NSIS installer locally (no publish)
GH_TOKEN=$(gh auth token) npm run release   # build AND publish a GitHub release
```

| Command | What it does |
| --- | --- |
| `npm start` | Run from source |
| `npm run dev` | Same, with devtools |
| `npm run build` / `npm run dist` | Build the installer locally, `--publish never` |
| `npm run release` | Build **and publish** to GitHub Releases (needs `GH_TOKEN`) |
| `npm run vendor` | Re-copy the RealtimeKit browser bundle into `src/renderer/vendor/` |
| `npm run icon` | Regenerate `build/icon.ico` |

### Shipping a release

Bump `version` in package.json, then `GH_TOKEN=$(gh auth token) npm run release`.
electron-builder builds the NSIS installer, generates `latest.yml` + a blockmap,
and publishes them to a GitHub release tagged `v<version>` on
`Scarmonit/scarmvoice`. That single step is the whole release: installed apps
pick it up through the update feed, and the website's "Download for Windows"
button (which points at `releases/latest/download/ScarmVoice-Setup.exe`) serves
it automatically — no site edit needed. The stable asset name is what makes the
`latest` redirect work, so don't put the version in the NSIS `artifactName`.

> **Installer, not portable.** electron-updater can't self-update a portable
> exe, so the Windows target is a one-click NSIS installer (per-user, no admin,
> creates a desktop shortcut, launches on finish). userData is keyed by
> productName, so a user upgrading from the old portable build keeps their
> settings and session.

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

### Formatting is DOM, not markup

The message renderer is ported from the website's `board.js` and keeps its
defining property: every node is built with `createElement` and every piece of
user text lands via `textContent`. No HTML string ever carries a message body,
so adding bold/code/lists/mentions added no injection path — `<script>` in a
message is text, in a code fence it's text, and inside `**bold**` it's text.
Only `http`/`https` becomes a link.

highlight.js is **vendored, not fetched**: the website pulls it from cdnjs, but
the renderer runs from `file://` under a CSP that forbids remote script, and a
`file://` page can't load ES modules either — so the package's `es/` build is
unusable as-is. `scripts/vendor-hljs.js` generates a classic-script bundle from
the npm package (core plus the same "common" language set, read out of
`lib/common.js` rather than hard-coded, so it tracks the pinned version) and
copies the same atom-one-dark theme. That keeps highlighting identical to the
website with no network at runtime.

### The camera and the screen share are different tracks

`forceScreenQuality()` pins the outgoing share to the active tier's bitrate,
resolution and framerate. It used to tune *every* outgoing video sender, which
was safe only while the app had no camera — now it matches on the share track's
own id, so camera video is left alone. Get this wrong and turning the camera on
silently re-tunes the screen share (or vice versa).

### Opening links

Every url in the app arrives from somewhere untrusted — a message body someone
else typed, or the `url` field of a server-side unfurl. `shell.openExternal` hands
that string to the OS, which will happily launch a registered protocol handler,
so an unchecked one is a remote-code-execution path on the machine of whoever
right-clicks it (`file://`, `ms-msdt:`, and friends).

So the scheme is **parsed, not pattern matched**, in both places: the renderer
won't offer Open link at all unless `new URL(...)` yields `http:`/`https:` — a
`javascript:` card falls through to the ordinary message menu — and
`app:openExternal` re-parses and returns false rather than trusting its caller.
The renderer check is for the menu; the main-process check is the one that
matters.

### Holding the reader's place

Rendering the list is a full `innerHTML` rebuild, and clearing a scroll container
resets `scrollTop` to 0 — so anyone reading history got thrown to the top by the
next background poll. Three things keep the view still:

- **Polls that change nothing render nothing.** The displayed list is signed
  (channel + filter state + the posts themselves); an identical signature skips
  the rebuild entirely, which also stops every image restarting its load.
- **A real rebuild restores an anchor** — the topmost still-visible message and
  its offset from the top of the viewport — instead of a raw `scrollTop`, so
  changes in the content above it don't matter.
- **A refresh only speaks for the newest page.** It used to replace `posts`
  wholesale, silently discarding history someone had paged back to; now older
  loaded messages are kept and only the newest window is replaced.

Late-loading images are the fourth case: they have no height until they load, so
one finishing above the viewport shifts everything below it. A capture-phase
`load` listener on `#messages` gives the scroll back exactly the height that just
appeared — or re-pins to the bottom if the reader was following the live edge.

Auto-scroll happens only when already at the bottom (within 120 px). Past 400 px
away, the **Jump to present** button fades in, badged with the number of messages
from other people since the reader was last caught up; past 4000 px it jumps
instantly rather than animating through thousands of messages.

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

### Uploads work for any file type

No code layer restricts file types — the historical blocker was Cloudflare's
managed WAF, which content-scans raw upload bodies and 403s files whose bytes
match attack signatures (real PDFs, Office docs, zips). Since the WAF runs before
the Worker, an authenticated user just saw "Upload failed (403)" with no way to
fix it in code. The fix is to send the upload body as **base64** (header
`x-file-encoding: base64`): the WAF sees opaque text and passes it through, and
the server decodes it byte-for-byte. Web and app both do this; the server
accepts raw bodies too for backward compatibility. Size limits (25 MB) stay
enforced on both the client and the decoded server bytes.

Serving is hardened separately: the server sniffs magic bytes and only serves
genuine images/audio/video **inline** (with the sniffed type); everything else —
PDFs, HTML, SVG, archives, unknown — downloads as `application/octet-stream`
with `attachment` disposition and `X-Content-Type-Options: nosniff`, so an
uploaded HTML or SVG can never execute in the site's origin. Extensions are
never trusted for inline rendering.

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

- RNNoise voice isolation (the browser's own noise suppression is used instead)
- Web Push — the app uses native OS notifications instead, which is the better
  mechanism for a desktop client
