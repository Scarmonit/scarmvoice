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

Grab **`ScarmVoice-Setup.exe`** from
[the latest release](https://github.com/Scarmonit/scarmvoice/releases/latest)
and run it. It is a one-click, per-user install — no admin prompt — and it puts
a desktop and Start-menu shortcut down and launches when it finishes. After
that the app updates itself; there is nothing to download again.

Signing in is two steps: the shared board password, then your own account
(username + password, verified by email the first time). The name everyone else
sees IS that username, which is what stops anybody wearing somebody else's. The
board session is remembered for 30 days.

> There is no portable build. electron-updater cannot self-update a loose exe,
> and an app that cannot update itself is an app stuck on whichever bug it
> shipped with — see *Shipping a release* below.

## What it does

**Voice**
- Cloudflare RealtimeKit SFU — the same room the website joins
- Open mic or push-to-talk, with a **global** PTT key that works while the app
  is in the background (keyboard keys or mouse side-buttons)
- Mute, deafen, and per-person local volume (0–200%) and mute, remembered
  between sessions
- Live speaking indicators
- **Camera** — turn on video in a call; everyone's tiles fill a responsive grid
  above the message list (one fills, two split, and so on), letterboxed to keep
  faces in frame. Click a tile to put that camera on the big stage and click it
  again to send it back to the grid, and each
  tile has hover buttons for fullscreen and pop-out (picture-in-picture), the
  same viewing options as the stage. The speaker's tile is ringed, and the one
  you're watching is outlined in the accent colour.
  Plain RealtimeKit video on the same meeting, so it works across desktop and web
- **Multi-presenter viewing** — several people can share a screen at once, and
  you choose which one you watch. The stage lists every live screen share and
  camera as a pill above the video; click to switch. Your choice sticks until
  that stream ends, at which point it falls back to someone else's screen. Share
  audio plays from its own element, so a presenter you aren't watching is still
  audible
- Microphone and speaker selection, echo cancellation / noise suppression /
  AGC toggles
- **Soundboard** — a tray of clips that everyone in the call hears, not just
  you. A clip is mixed into the outgoing microphone track, which is the only
  way it reaches the SFU; see [The soundboard is in the mic, not the
  speakers](#the-soundboard-is-in-the-mic-not-the-speakers). Clips are served
  from the website's existing `/assets/audio/` library, and the level is
  remembered

**Presence**
- **Members list** — everyone here, not just the call: online / away, their
  status line, and who's in voice, in one list. People in voice keep the
  per-person volume controls
- **Custom status** — set a status beside your name, shared with the website
- **Moderation** (admins) — from the person popover: **Remove from voice**, which
  ends their call on every device they have open, and **Ban**, which signs them
  out everywhere and keeps them out. Deleting anyone's message and the full
  member list (roles, ban/unban, password reset, 2FA reset, delete) are in
  Settings → Members. See [A kick is two halves](#a-kick-is-two-halves)

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
- **Custom emoji** — upload an image under a name and use it as `:name:` in any
  message or as a reaction. Stored on the server, so the website and the phone
  app see the same set; add and remove them in Settings → Custom emoji. Anyone
  can add one, you can remove your own, and an admin can remove any
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
- **Per-channel notifications** — each channel is **All messages**, **Only
  @mentions**, or **Nothing**, from the channel's right-click menu or Settings →
  Notifications. A quieted channel is dimmed and stays out of the taskbar badge.
  Mentions-only works for channels you aren't looking at too; see
  [Mentions-only in a channel you can't see](#mentions-only-in-a-channel-you-cant-see)
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
| `npm test` | Unit + jsdom suite (vitest) |
| `npm run test:e2e` | Launch the real app and drive it with Playwright |
| `npm run vendor` | Re-copy the RealtimeKit browser bundle into `src/renderer/vendor/` |
| `npm run icon` | Regenerate `build/icon.ico` |

### Tests

Three tiers, each covering what the one below it can't reach:

- **Unit** (`test/*.test.js`) — the main-process modules, loaded through Node's
  CommonJS registry against a fake `electron` (`test/stubs/`) so they share one
  instance the way they do at runtime, plus `renderer/lib.js` directly.
- **Renderer boot** (`test/renderer-boot.test.js`) — evaluates `index.html`'s
  real DOM and every renderer script in jsdom against a stubbed `window.lounge`.
  This is the guard for the whole class of bug a 5000-line IIFE invites: a helper
  can be renamed, moved, or deleted and *nothing* complains until the window is
  blank. Every top-level wiring line — hundreds of `addEventListener` calls
  against elements that must exist by that id — runs here.
- **E2E** (`test/e2e/`) — launches the actual Electron app. It covers the
  "silently does nothing" failures that live in main.js's window and session
  wiring, where a missing permission makes a promise *hang* rather than reject.

> `npm run test:e2e` refuses to run while ScarmVoice is open: a second instance
> fights over the user-data lock and the system-wide uiohook, which hard-crashes
> the running one. Close it first (`Stop-Process -Name ScarmVoice`).

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
    log.js       rotating log file + crash reporter
    badge.js     the taskbar unread-count overlay (drawn pixel by pixel)
    updater.js   auto-update + release-note parsing
    preload.js   the only renderer↔main bridge (contextBridge)
  renderer/      UI — no network access of its own
    app.js       chat, channels, roster, settings
    lib.js       the pure half of the renderer — unit-tested
    audio.js     the ONE AudioContext + the shared level-meter tick
    voice.js     RealtimeKit SFU engine
    sounds.js    join/leave/message chimes
    icons.js     the single icon set
    vendor/      RealtimeKit bundle, copied from node_modules at install
```

`lib.js` and `audio.js` exist for reasons worth stating outright.

**`lib.js`** — `app.js` is one very large IIFE where almost every line touches
the DOM, `window.lounge`, or module state, so none of it could be unit-tested:
the entire renderer, *including the escaping between a message someone else
wrote and this window*, had zero coverage. Everything pure now lives in `lib.js`
and is tested directly. Anything needing the DOM or app state stays in `app.js`.

**`audio.js`** — Chromium caps a page at **six** concurrent `AudioContext`s. The
renderer used to create one per participant for speaking detection, another per
participant boosted above 100%, one for the microphone test, and one for the
chime. In a call with four other people the seventh constructor call throws, and
because the failure was caught and ignored, the only symptom was the speaking
indicator quietly not working for whoever joined last. One shared context has no
such limit — analysers and gain nodes are cheap, contexts are not. It also owns
the single 20 Hz tick that drives every meter, replacing a per-participant
`requestAnimationFrame` running at 60 Hz (and stalling whenever the window was
hidden).

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
notification permissions. Every `ipcMain` handler also checks that the call came
from our own top frame before running.

### The account token never crosses into the renderer

Board accounts add a second credential (`x-account-token`) alongside the gate
cookie, and it is bearer-equivalent — whoever holds it can mint sessions. Every
endpoint whose response carries it (`account/login`, `register`, `verify`) has
its own main-process handler that keeps the token and hands back only the parsed
user. The generic `board:call` proxy returns the server's JSON verbatim, so it
is allowed to reach only the read-only corner of that namespace.

That allowlist is applied to the **resolved** path, not the string the renderer
sent, and the resolved path is what gets requested — see `boardpath.js`. A check
on the raw string is worthless here: `net.js` concatenates the path onto the base
URL unparsed and the URL parser collapses dot segments, so
`../../api/board/account/login` and `x/../account/login` both read as innocent
relative paths while resolving to exactly the endpoint being denied.
`test/boardpath.test.js` is the regression test.

Redirects are followed by hand for the same reason (`net.js`). `redirect:
'follow'` strips `Cookie` and `Authorization` across an origin change but *not* a
custom header, so `x-account-token` would be replayed to whatever host the chain
ended on; and the cookie-rotation capture would key off the origin that answered
last rather than the one we chose to trust. Following each hop ourselves means
both decisions are re-made against the allow-list every time.

### Voice settings that are deliberate, not accidental

These match what the website already verified against this SFU:

- `enableHighBitrate: true` gives 64 kbps mono Opus. This SDK has **no** numeric
  bitrate field — the only other setting is `enableStereo`, which raises it to
  128 kbps *and* forces `channelCount: 2`. The two are welded together in the
  SDK, so 128 kbps mono is not reachable, and stereo on a mono mic doubles the
  bytes for nothing (RNNoise forces mono anyway).
- **AGC defaults to off.** Its level loop audibly self-modulates the volume. The
  mic test in Settings builds its constraints from the same `micTestConstraints()`
  the engine uses, so the speaking threshold is calibrated against the chain the
  call actually runs — testing with browser defaults (AGC **on**) meant quiet
  talkers passed the meter and then sat below the threshold in the call.
- The SDK reads the *misspelled* getUserMedia key `noiseSupression` (one `s`),
  so `voice.js` passes both spellings. Chromium's suppressor is turned **off**
  when RNNoise is enabled: cascading two suppressors is what produces pumping
  and chewed-up consonants.
- **RNNoise needs `'wasm-unsafe-eval'` in the renderer's CSP.** Chromium gates
  WebAssembly compilation on `script-src`, so under a bare `'self'` the worklet's
  `WebAssembly.instantiate` threw *"Refused to compile or instantiate WebAssembly
  module"*, `noise.js` reported the failure, and `app.js` switched the toggle
  straight back off with an error toast — the setting could not be turned on at
  all. `'wasm-unsafe-eval'` is the narrow directive for exactly this: it permits
  WebAssembly and nothing else, leaving `eval()` and `new Function()` blocked.
  Both halves are asserted in the e2e suite, so widening it to `'unsafe-eval'`
  later would fail the tests.
- The microphone must be selected with `meeting.self.setDevice()`. A `deviceId`
  in `mediaConfiguration.audio` is silently ignored — the SDK takes the device
  as an argument to its constraints builder, sourced only from `setDevice` — so
  without that call the SDK just uses `audioInputDevices[0]` and the picker in
  Settings changes nothing but the test meter.
- Participants are keyed by `customParticipantId` (which equals the board's
  client id) rather than the per-session participant id, so per-person volume
  and mute settings survive restarts and match the website's.
- Audio senders are set to `networkPriority: 'high'` and the screen share to
  `'low'`. They share one bundle, and at default priority a multi-megabit share
  and the voice stream compete as equals — so voice is what broke up when the
  uplink saturated.
- The RealtimeKit SDK is **pinned to 2.0.0** — the version those behaviours were
  verified against — and vendored from `node_modules` instead of a CDN so the
  packaged app has no external script dependency. It is **fetched on the first
  join**, not at startup: 647 KB of parse and execute that used to sit between
  launching the app and seeing a window, for a feature many sessions never use.

### Quality survives a reconnect

A transport drop makes the SDK tear the peer connection down and rebuild the
producers. Everything `forceScreenQuality()` pinned — bitrate, framerate,
`scaleResolutionDownBy`, `degradationPreference` — lives on the old sender and
dies with it, and `SHARE_TRACK_ID` still names the dead track, so nothing would
re-match even on a manual retry. One Wi-Fi blip mid-share used to drop the share
to the SFU default (~720p) for the rest of the session, silently.

`wireReconnect()` listens for `mediaConnectionUpdate` / `roomJoined` and
re-applies the tuning, so the pinning is restored rather than merely established
once.

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

Camera tiles reuse the screen-share stage's viewing controls through two shared
helpers, `toggleFullscreen(el)` and `togglePip(video)`, rather than a second
copy. Fullscreen is requested on a **wrapper** element (the tile, not the bare
`<video>`) and depends on the Electron `'fullscreen'` permission being granted
in `main.js` — without it `requestFullscreen()` silently no-ops and the button
looks dead, which is exactly the bug the share stage hit once. Pop-out is the OS
picture-in-picture window (always-on-top, resizable, aspect-preserving). The
tile's own tool buttons `stopPropagation` so they don't also trigger
click-to-watch.

### One stage, many sources

`voice.js` keeps presenters in a `Map` keyed by participant id and emits the
whole set through `onShares`, because the SFU carries as many screen shares as
people start — the earlier one-slot model made a second presenter silently
replace the first with no way back. The renderer flattens shares and cameras
into one list of stage sources (`screen:<cid>` / `cam:<cid>`). `watching` holds
an **explicit** pick and is honoured until that stream disappears, so a new
presenter never yanks the view out from under you; with nothing picked the stage
falls back to a screen share, and to nothing at all if there is none — cameras
are never auto-promoted, or one person turning a webcam on would claim half the
window when the grid was already doing the job.

Two consequences worth keeping:

- The `MediaStream` for a share is **reused** while its track ids are unchanged.
  The SDK re-fires `screenShareUpdate` for unrelated reasons, and rebuilding the
  stream each time would swap `srcObject` and flash the video black mid-talk.
- Share audio rides a hidden `<audio>` per presenter rather than the on-screen
  `<video>`, which is what lets you keep hearing someone you're not watching.
  The stage `<video>` is therefore *always* muted — that also removes the old
  feedback-loop guard around your own share. Those elements follow deafen and
  the same per-person volume/mute prefs as the presenter's microphone.

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

Rendering used to be a full `innerHTML` rebuild, and clearing a scroll container
resets `scrollTop` to 0 — so anyone reading history got thrown to the top by the
next background poll. Four things keep the view still:

- **The list is diffed by key, not rebuilt.** Each row (a message, a day
  separator, the *Load earlier* button) carries a key and a signature over
  everything that affects how it draws. Unchanged rows keep their existing DOM
  node; a changed message rebuilds only itself. A single new message used to
  discard every node on screen, which restarted every image and video load and
  threw away link previews that had already been fetched — `renderPreviews` then
  had to fetch and re-graft them all over again.
- **A rebuilt row restores an anchor** — the topmost still-visible message and
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

Retained history is capped at 400 messages, trimmed **only** while the reader is
following the live edge with no filter applied — trimming under a reader who has
deliberately paged back, or who is filtering across that history, would take away
exactly what they asked for. `hasMore` is re-armed when it trims, so the trimmed
page is immediately reachable again via *Load earlier*.

### Messages typed while offline

A failed send is queued rather than handed back to the composer with an error
toast. Queued messages appear in the conversation, dimmed, and go out
automatically when realtime reconnects — or on the next poll, whichever comes
first. The queue is persisted to `localStorage`, because "the app crashed and ate
my message" is the worst possible outcome for something already sent.

The distinction that matters: only *network* failures queue. Anything the server
actively rejected (too long, bad channel) is handed straight back, because
retrying it will never help. Attachments are deliberately never queued — the
bytes can be tens of megabytes and `localStorage` is not the place for them.

Reads are retried in `net.js` too, twice with backoff, on a dropped connection or
a 429/502/503/504. **Writes never are**: the failure can happen after the server
already accepted the post, so a retry would send it twice.

### One composer, and the drafts in it

There is a single composer element. Opening a conversation *moves* the node into
the drawer rather than building a second one, which is what keeps every
listener, sub-control and pixel of it identical in both places.

The cost is that a DOM node carries its contents with it. A half-typed message
written for `#general` was still in the box after clicking through to a
conversation, so the next Enter sent it to whoever was on the other end — and a
file that had been attached but not sent went the same way, into a private
conversation it was never meant for.

Discarding on the move would fix the misdelivery and introduce a worse problem,
since nothing else in this app throws away text somebody has already typed. So
the composer's contents are stashed under the surface they were written for and
handed back on return: channels share one draft (as they always did), and every
conversation gets its own. The stash is dropped on sign-out, because thread ids
are global rather than per-account and the next person to sign in on that
machine must not find someone else's draft waiting in a conversation of theirs
that happens to share the number.

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

Both paths use **one** matcher (`lib.js`'s `matchesPttBinding`, mirrored by
`ptt.js`'s hook matcher) so they cannot drift. The in-window path previously
compared only `event.code`, which meant a binding of Ctrl+Q also opened the mic
on a bare Q. Two details are deliberate:

- **Key-up ignores modifiers.** Releasing Ctrl before Q would otherwise leave the
  mic open, because the keyup for Q no longer satisfies the binding.
- **A modifier can be the trigger key.** Binding PTT to Shift records
  `shift: false`, but the event that fires it reports `shiftKey: true` — requiring
  it both ways would never match.

Losing window focus mid-hold releases PTT, but **only when the native hook is
unavailable**. With the hook loaded, holding the key while working in another
window is the entire point; without it the key-up lands in whatever window took
over and the mic would stay open indefinitely.

**Changing the voice mode clears the held state**, and every one of the four
controls that can change it has to. `pttHeld` only means anything while the mode
is `ptt` — the transmit gate is `!muted && (mode === 'ptt' ? pttHeld : true)` —
and both key handlers bail on `voiceMode !== 'ptt'`. So a key still held when the
mode changes never has its release recorded, and the next switch back to
push-to-talk re-reads a stale `true` and opens the microphone with nobody holding
anything.

### The soundboard is in the mic, not the speakers

Playing a clip through the speakers reaches exactly one person: whoever pressed
the button. For it to reach the call it has to be **mixed into the outgoing
microphone track**, because that track is the only audio this client publishes.

So `soundboard.js` patches `getUserMedia` and returns the mic summed with a
soundboard bus. That is the same trick `noise.js` uses, and the load order in
`index.html` is load-bearing: `noise.js` is first, so its patch is the inner one
and the stream we mix into is already denoised. That ordering is the point —
RNNoise is a *speech* model, and running a vine boom through it mangles it.

The cost is one extra `MediaStreamSource`→`MediaStreamDestination` hop on every
mic acquisition, whether or not a clip is ever played. That is accepted on
purpose. The alternative is republishing the mic track the first time somebody
hits a sound, which drops audio mid-sentence for the whole room; and the mic
already round-trips through RNNoise's worklet, so this is the same class of cost
the pipeline pays anyway.

Every failure path returns the **original** stream untouched. A soundboard is a
toy and a microphone is not, so a broken mixer must cost you the toy.

The clip is also connected to `ctx.destination`, so you hear what you played —
without that second tap the presser is the only person in the room who can't.

### A kick is two halves

`POST /api/board/voice/kick` clears the target's `voice_presence` rows **and**
pushes a `voicekick` event to every device that account has open. Doing only the
first is worse than doing nothing: the voice engine heartbeats into
`/voice/presence` on a timer, so the row it just lost comes back within about two
seconds and the person "removed" flickers out of the roster and returns, having
been able to talk the whole time. Doing only the second leaves their tile behind
after they've gone.

It is addressed by **account**, never by client id — a cid is published with
every post, so accepting one would let any member evict any other.

A kick is deliberately not a ban. It ends the current call and they may rejoin
immediately; `account/manage` with `action: 'ban'` is the one that sticks, and
the confirm dialog says so rather than implying permanence it doesn't have.

### Mentions-only in a channel you can't see

Three levels per channel — all, mentions, nothing — are easy for the channel on
screen, where `loadMessages` has the message bodies and can just look. The hard
case is a channel you are *not* looking at: the realtime nudge is
`{ t: 'posted', channel, cid }` and carries no body by design, so mentions-only
had no way to tell an @you from ordinary chatter and the honest answer was
silence. That made the setting useless everywhere except the one channel that
needed it least.

The fix is to send the matched **names** rather than the body: the poster runs
the same `mentionsMe` matcher over the roster and puts the hits in the `posted`
event, so the wire carries `["ava"]` instead of the message. The receiver checks
whether it's in that list.

It is sender-supplied and therefore untrusted, which is fine for what it does —
the worst a liar achieves is a notification for a message that doesn't mention
you, which they could already get by typing your name. The Durable Object clips
and caps the list so it can't be used to fan out bulk data, and a client too old
to send it reads as "no mentions", which is exactly the behaviour that existed
before the hint did.

`mutedChannels` (the old binary list) is still written alongside the new
`channelAlerts` map, so a channel silenced here stays silenced on the website and
in older builds.

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

- Web Push — the app uses native OS notifications instead, which is the better
  mechanism for a desktop client
