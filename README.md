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
- **Members list** — everyone on the board, not just the call and not just the
  people who are here: **Online** (green), **Idle** (yellow) and **Do Not
  Disturb** (red) together at the top, then a separate **Offline** section,
  faded, for everyone who isn't. Their status line and who's in voice are on the
  same rows; people in voice keep the per-person volume controls
- **Four statuses, set both ways** — Idle arrives on its own after five minutes
  with nothing touched, and closing the app takes you out of the list
  immediately. Or choose for yourself from the me-bar: Online, Idle, Do Not
  Disturb or Invisible, and the choice outranks the clock
- **Status in a conversation** — the profile beside a direct message says
  whether that person is there, on their face and again in words
- **Custom status** — set a status beside your name, shared with the website
- **Three roles — Owner, Admin, Member** — with a hard line between moderating
  CONTENT and touching an ACCOUNT. An admin edits, deletes and pins anyone's
  messages and creates and renames channels; only the Owner bans, resets
  passwords, clears 2FA, deletes accounts, changes roles or deletes a channel. The
  Owner cannot be demoted, banned or removed by anybody. Every rule is enforced on
  the server, not merely hidden in the UI. See
  [Roles and permissions](#roles-and-permissions)
- **Role changes apply instantly** — a promotion or demotion takes effect on the
  affected person's screen with no sign-out and no restart, and tells them what
  happened with a dialog they dismiss
- **Moderation** — from the person popover: **Remove from voice** (admins), which
  ends their call on every device they have open, and **Ban** (Owner), which signs
  them out everywhere and keeps them out. The member list — roles, ban/unban,
  password reset, 2FA reset, delete — is in Settings → Members, for the Owner. See
  [A kick is two halves](#a-kick-is-two-halves)
- **Edits are attributed** — a message a moderator edited says *"edited by
  <name>"* with the time, rather than the bare *(edited)* an author's own
  correction gets. The byline still shows the author, so the two must be tellable
  apart
- **Resizable side panels** — drag the inner edge of the channel list or the
  member list to set its width. Horizontal only, with limits that keep both usable
  and stop either crowding the messages, and the width is remembered between
  sessions. Double-click a handle to reset it; the arrow keys work too

**Chat**
- Channels with unread badges; create, rename, delete
- Full history with infinite scroll, day separators, and message grouping
- **Search** — one box in the header (Ctrl+F), with a **filters dropdown** under
  it: *from:*, *has:*, *mentions:*, and **More filters**, which opens a form —
  From, In, Has, Mentions, Date, Author Type, Pinned, over Clear Filters /
  Cancel / Apply Filters. Every one of them is **typeable as well as
  clickable** — the menu and the form both write operators into the box rather
  than holding filters beside it. Operators narrow the messages already loaded,
  instantly;
  the free text also goes to `/api/board/search` for the whole archive, scoped
  to this channel or all channels, with the match highlighted and click-to-jump
  (into the thread, if the hit is a reply)
- **Message formatting** — `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||`,
  `` `code` ``, ```` ```fenced blocks``` ```` with syntax highlighting, lists and
  blockquotes. Same renderer as the website, so a message reads identically in
  both; see [Formatting is DOM, not markup](#formatting-is-dom-not-markup)
- **Emoji picker** — react with any emoji from the message menu or the hover
  bar, and insert emoji into the composer. Same set as the website
- **Custom emoji** — upload an image under a name and use it as `:name:` in any
  message or as a reaction. Stored on the server, so the website and the phone
  app see the same set; add and remove them in Settings → Custom emoji. Anyone
  can add one, you can remove your own, and a moderator can remove any
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
- **You're Viewing Older Messages** — a banner centres itself over the bottom of
  the conversation once you scroll away from the live edge, with **Jump To
  Present** on its right and a badge for how many messages arrived while you
  were up there. New messages never yank your scroll position, including when
  images and link previews above the viewport finish loading
- **Link actions** on right-click — Open link (in your default browser) and Copy
  link address, on bare URLs in a message and anywhere on a YouTube or Open Graph
  preview card, thumbnail and padding included. Only `http`/`https` is ever
  offered; see [Opening links](#opening-links)
- **Spellcheck with corrections** — misspellings are underlined as you type, and
  right-clicking one lists the words you probably meant at the top of the menu.
  Click a suggestion and it replaces the word; "Add to dictionary" stops a name
  or an in-joke being flagged again. Chromium's own spellchecker, which on
  Windows 10+ means the OS one: no dictionary download, nothing sent anywhere,
  works offline. See [Spellcheck](#spellcheck)
- **Text-field menu** on right-click — Cut / Copy / Paste / Select all, greyed out
  when they'd do nothing (nothing selected, empty clipboard). Paste runs as a
  native editing command, so an image on the clipboard stages as an attachment
  exactly as Ctrl+V does. Every editable field has it, not just the composer
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

**Direct messages** — one-to-one and groups, and **everything above works in
them**
- **New Message** — the **+** beside *Direct Messages* (tooltip: *Create
  Message*) opens a titled dialog: a search box over the board's members, each
  row with their picture, the name they post under and the account under it, and
  a checkbox. Tick one person to open the conversation you already have with
  them, or several to start a group — up to 10, stated in the dialog rather than
  refused afterwards. It is a **layout of the existing picker**, not a second
  one; see [One picker, two layouts](#one-picker-two-layouts)
- **Find or start a conversation** — the palette is still its own thing, and
  still the one that jumps you to a channel
- **The same search** — the header's search bar *moves into* the conversation,
  so a DM gets the real one: every operator, the filters dropdown, **More
  filters**, the match count, and an archive search over the whole conversation
  (**This conversation** / **All conversations**). `from:` and `mentions:` offer
  the people in that conversation and `in:` offers your conversations; see
  [One search, two places](#one-search-two-places)
- **The same header** — Threads, Notification Settings and Pinned Messages are
  the *same three buttons*, moved into the conversation header rather than
  rebuilt there. A conversation has its own pins, its own threads and its own
  notification level, and none of them is the channel's
- **The same message actions** — react, reply, reply in thread, pin, copy, save
  attachment, edit, delete and block, from the hover bar or the right-click
  menu, exactly as in a channel. Reply counts, reaction chips, quote blocks and
  the *pinned* tag all render the same way, because they are the same component
- **Threads inside a conversation** — a thread hangs off a message here too, and
  opens in the same drawer, beside the conversation rather than underneath it
- **Group conversations** — add people, name the group, leave it
- **One exception, on purpose** — a moderator cannot edit or delete somebody
  else's message in a private conversation, and the server refuses it too. See
  [A DM is a channel message](#a-dm-is-a-channel-message)

**Sounds** (same assets as the website, `src/renderer/sounds/`)
- Join / leave chimes, armed only while you're in the call and with a 1.5 s
  settle window so the people already there don't each chime
- New-message chime, decoded through Web Audio with an id watermark so a message
  chimes exactly once even when the poll and socket both see it
- Both independently toggleable in Settings

**Desktop**
- **Auto-update** via electron-updater against GitHub Releases, applied **before
  the app starts**: launching checks the feed first, and if there is an update it
  is downloaded and installed behind a small "Updating…" window, then the app
  opens on the new version. Nothing signs in, connects or opens a microphone
  until that has happened. Downloads are **differential** (only changed blocks),
  so a point release is a ~1 MB fetch, not the full installer
- **An update published while you are using it announces itself** — an **Update
  Available** pill appears at the top of the window within a second or two, with
  no *Check for Updates* to press. Publishing a release broadcasts down the
  board's realtime socket and every open client checks at once; a five-minute
  sweep (and a check on every wake) covers anyone who was not listening. One
  click installs and reopens on the new version, and clicking while it is still
  downloading is remembered rather than refused. Nothing restarts without being
  asked — see [Telling a running app about a
  release](#telling-a-running-app-about-a-release)
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
| `npm run release` | Build **and publish** to GitHub Releases (needs `GH_TOKEN` and `build/release-notes/v<version>.md`) |
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
  wiring, where a missing permission makes a promise *hang* rather than reject —
  and the ones that need **layout**, which jsdom has none of. A `position: fixed`
  panel drawn 31px out of place because an ancestor grew a CSS filter is invisible
  to every rect in the other two tiers, because every rect in them is zero.

> `npm run test:e2e` refuses to run while ScarmVoice is open: a second instance
> fights over the user-data lock and the system-wide uiohook, which hard-crashes
> the running one. Close it first (`Stop-Process -Name ScarmVoice`).

`test/helpers/renderer.js` boots the real renderer into jsdom, and it cannot shut
one down again — `teardownSession()` is private to `app.js`. So the previous
instance's poll, presence heartbeat, DM poll and avatar sweep all keep firing, and
its `$(…)` lookups resolve against the **same document**: a stale instance
repaints the fresh one's UI out of its own state — a channel badge cleared, a row
rebuilt with the wrong role's action bar, a banner filled in with the previous
fixture's numbers. Because it depends on scheduling, it lands on whichever spec
the machine treated worst, so it reads as some unrelated feature failing at
random. `bootRenderer` now silences the previous instance first: `app.js` captures
`const L = window.lounge` by *reference*, so replacing that object's `board()` with
a promise that never settles reaches the old instance, and every fetch-then-render
path it has is rooted in that one call. Its timers still fire; they just never get
an answer to draw. Files that boot repeatedly should still prefer one boot and a
mutable fixture — it is faster and there is less to go wrong.

### Shipping a release

Bump `version` in package.json, **write `build/release-notes/v<version>.md`**,
then `GH_TOKEN=$(gh auth token) npm run release`.

> **The notes are a build input, not an afterthought.** First line is the release
> title ("The audit pass"); the rest is the body, written for the person running
> the app rather than for whoever wrote the code — plain language, no file names,
> no internal identifiers. A line that is entirely bold is a section heading and
> `- ` lines are bullets, because that is what `updater.js`'s `parseNotes()`
> reads (see `scripts/release-notes.js` for the format and any existing file for
> the house style).
>
> Attaching them used to be a manual `gh release edit` afterwards, which meant it
> lived in somebody's head and in no file — so v0.56.0 went out blank, and blank
> is not cosmetic: this text is the *only* thing the app can say about a version,
> in the update banner someone reads while deciding to accept it and in
> Settings → About. The preflight now refuses to build without them, and
> `publish-release.js` attaches them and re-reads them off GitHub before it flips
> the release live. `test/updater-notes.test.js` parses every file in that folder
> and fails if one would render as a single shapeless paragraph.
electron-builder builds the NSIS installer, generates `latest.yml` + a blockmap,
and uploads them to a release tagged `v<version>` on `Scarmonit/scarmvoice`.
That single step is the whole release: installed apps pick it up through the
update feed, and the website's "Download for Windows" button (which points at
`releases/latest/download/ScarmVoice-Setup.exe`) serves it automatically — no
site edit needed. The stable asset name is what makes the `latest` redirect
work, so don't put the version in the NSIS `artifactName`.

> **It uploads to a DRAFT, and `scripts/publish-release.js` flips it live as the
> last step — only once both assets are actually on it.** electron-builder
> creates the release record on the first upload and streams the bytes
> afterwards, so publishing straight to a live release meant that for the whole
> length of an 84 MB upload `releases/latest` resolved to a release with nothing
> in it: the download button 404'd and every client checking for an update got
> an error instead of a `latest.yml`. A draft is invisible to both, so a run that
> dies mid-upload changes nothing for anyone — and `gh api …/releases/tags/<tag>`
> 404s on a draft, so the tag preflight still passes on the retry and
> electron-builder reuses the draft it left behind.
>
> The order inside the script matters too: `npm run vendor` runs FIRST, so the
> preflight's stale-worklet assertion judges the file this build will actually
> package rather than whatever an earlier run left on disk.

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

### Two themes, not one theme inverted

The dark theme builds depth out of **shade**: the rail is the darkest column, the
sidebars sit a step above it, the message column above that, and anything that
floats — a menu, a modal, a popover — is lighter still. There is always more room
above the surface you are on.

A light theme has no such room. White is the ceiling, so the same ramp turned
upside down produces exactly what it sounds like: a flat white app with near-black
text. Which is what this one was — the settings pane described it as "the same
layout, inverted", and it measured that way, seven pure-white surfaces with no
hierarchy between them and `#06060a` on top.

So the light palette is written from its own premises:

- **The page is layered off-whites, none of them `#fff`** — rail `#e4e6ea`,
  sidebars `#eef0f3`, message column `#fafbfc`, member list `#f4f6f8`. The member
  list gets a step of its own that it does *not* have in the dark theme: two white
  columns divided by a hairline read as one sheet.
- **Only the things that float are white.** Modals, menus, popovers, tooltips, the
  composer and the settings sheet are the paper; everything else is the page under
  it. That is what makes a menu read as being *in front of* the app rather than as
  another patch of the same surface — and it is why a card raised on a floating
  surface (`--float-2`) is *darker* there and *lighter* in the dark theme. That one
  inversion is deliberate and is asserted in the tests as the opposite of its dark
  counterpart.
- **No pure black anywhere.** Three real steps instead of one, measured against the
  message column: headings 14.2:1, prose 12.2:1, labels 9.5:1, muted 7.2:1,
  timestamps 4.7:1. The quiet end is deliberately still legible — copying the dark
  theme's brightness *ratios* would have put channel names at 3:1.
- **Status colours stay mid-tone.** The inversion had darkened every one of them
  until a 10px presence dot read as a hole punched in the page.
- **Shadows carry "this floats"**, since a floating surface can no longer be
  lighter than the page — soft, wide, and tinted with the text near-black rather
  than pure black, which at these alphas reads as dirt on the screen.

**The root cause was never the values.** It was that a component with a colour it
needed wrote that colour down: the pinned card's `#28282d`, the filter sheet's
fields, the settings rail's selected pane at `#2e2e33`, the slider tick marks at
`rgba(255,255,255,.3)`, the two popovers' outlines, four box-shadows, and — in JS,
where no stylesheet could reach them at all — the generated avatar's `hsl(h,70%,62%)`
and the profile banner's `hsl(h,32%,17%)`. Every one of those is a token now, with
a value in each theme; the avatar and banner take their saturation and lightness
from `--av-*` and `--banner-*` so the one colour that lands on every surface can
answer to the theme. Two tests keep it that way: **no dark literal, and no
white/black wash, may appear in an ordinary rule** — only in a theme block, or in
the handful of surfaces that are black in both themes on purpose (video, the
lightbox, the share picker).

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

### The connection is kept, not rebuilt

`fetch` in the main process is undici, and undici destroys an idle socket four
seconds after the last response — its `Agent` default. Cloudflare sends no
`Keep-Alive: timeout=` hint that would raise it, and **every** cadence in this
app is longer than four seconds: the idle poll is 60 s, the DM poll 12 s, the
thread poll 2.5 s, and anything a person does by hand is minutes apart. So
essentially nothing was ever reused, and every request paid a fresh TCP
handshake and TLS negotiation — two extra round trips in front of the one
carrying the answer.

Measured in the shipped runtime against the real origin, four requests at a
six-second cadence:

| | per request | connections opened |
| --- | --- | --- |
| default dispatcher | 224, 114, 119, 125 ms | **4** |
| `keepAliveTimeout: 30000` | 123, 40, 43, 43 ms | **1** |

The connection count is the causal evidence; the timings are its consequence.
That is ~75 ms off every channel switch, thread open, search, send and
attachment fetch.

The swap cannot live in `net.init()`. Node builds the global dispatcher
**lazily**, so the well-known symbol is still `undefined` at that point — code
placed there reads nothing, does nothing, and ships no benefit while looking
entirely correct. It is attempted on each request instead, which is free once it
has taken, and whose worst case is exactly the behaviour it replaces.

### Nothing waits for an answer it already has

Startup used to make five round trips in a row before it could draw a message,
and two of them were avoidable:

- **`account/me` was asked twice.** The account gate asks it and keeps the
  answer; `enterApp()` then asked the identical question again — same endpoint,
  same install id, milliseconds later — and the socket, the channel list and the
  first page of messages all waited behind it.
- **The first `list` waited behind the emoji/avatar/channel burst.** It depends
  on none of them. Only its *render* does, and that still happens after they
  land, so a message is never drawn as `:shrug:` text or as initials that later
  swap to a face. Moving the request meant asking for a primary read
  explicitly — running after the channels POST used to get that for free.

And the two calls the renderer opens with now go out **during window creation**
(`net.prefetchSession`), because the renderer cannot ask for anything for the
~280 ms it spends coming up, and nothing was on the wire for any of it. They are
the same calls made by the same functions, with the same side effects; only the
timing moves. Strictly one shot, so a re-login always reaches the server.

Measured on this machine, two runs each, from process start:

| | v0.48.0 | now |
| --- | --- | --- |
| `/auth/status` leaves | 421 ms | **151 ms** |
| `account/me` calls | 2 | **1** |
| `list` leaves | 192 ms after the burst | **with the burst** |
| first messages on screen | ~1380 ms | **~1040 ms** |

The window no longer opens on the sign-in card either. It was visible in markup
and only hidden once the session check came back, so every launch painted a
blurred scrim and a password field for a couple of hundred milliseconds before
throwing them away. It is hidden in markup now and every path that wants it
unhides it by hand — with a 400 ms deadline in `boot()`, because withholding it
is only acceptable while an answer is plausibly coming, and `net.js` waits
twenty seconds before giving up.

### The renderer cannot see whether the window is on screen

`backgroundThrottling: false` is deliberate — it keeps the presence heartbeat
and the fallback poll alive in the tray, which is what fixed the "messages stop
after an hour minimised" bug. The price, which nothing in the code accounted
for, is that Chromium then stops maintaining the visibility API too:
`document.hidden` reads `false` through **both** a hide to the tray and a
minimize, and `visibilitychange` never fires at all. Verified in this Electron
build, both ways, and again in the running app.

Five guards were written against that flag, so not one of them had ever run. The
thread poll kept asking every 2.5 s, the DM poll every 12 s, the shared 20 Hz
meter tick kept running a 512-sample RMS loop per call participant, and the
decorative animations kept repainting — all for a window nobody could see.

`main.js` watches the real window events and sends `win:hidden`; `appHidden()`
in the renderer is the single place the answer comes from, so the guards cannot
drift apart again. Coming back is the half that makes skipping safe: the panel
refreshes moved onto `app:resync`, which main really does send on
restore/show/focus.

The CSS side is an **explicit list** of the animations to pause, not
`html.win-hidden *` — a universal selector invalidates the computed style of
every element on both hide and show, and the show side lands exactly on
restore-from-tray, spending a felt interaction to save background work.
`animation-play-state: paused` rather than `animation: none`, so they resume
mid-cycle and nothing pops.

The one place `document.hidden` is still read is the presence rule, left exactly
as it is on purpose: making it work means minimising would publish you as away
to everyone, which is a change to what other people see and belongs in its own
commit.

### The gear opens the panel, then fills it in

Settings awaited `enumerateDevices()` before revealing the sheet. That call is a
trip through Chromium's audio service and it is slow cold — **312 ms** on this
machine's fifteen endpoints — so the gear sat there doing nothing for a third of
a second, to populate two dropdowns that live in Voice & Audio, which is not
even the pane that opens. It runs after the reveal now (click to visible:
16.5 ms), which is the rule the mic and speaker popovers already followed, and
it shares the device list those popovers keep rather than opening a second
enumeration of its own — so a reopen fills the selects in the same frame. The
refresh still lands and re-applies the saved value, so a device plugged in since
is picked up; if it comes back empty the selects are left alone rather than
blanked to *System default*.

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

A fence with **no language** runs auto-detection across that whole set, and it
is not cheap: measured against this bundle, 1.2 ms for a one-line fence, 2.7 ms
for a stack trace and 9.3 ms for a 1500-character paste, against 0.06–0.36 ms
when the language is named. That was paid again on every rebuild of the row — an
edit, a reaction, a channel switch back, a resync. hljs is deterministic for a
given (text, language), so the result is memoised in a bounded map, and the
cache stores the **class name as well as the markup**: `highlightElement` adds
`hljs`, and the entire theme hangs off that class, so replaying the HTML alone
gives an unstyled, unpadded, transparent block. Narrowing the language set would
also make detection faster, and is not done — that trades quality for speed.
Blocks past 50,000 characters (10,000 with no language named) are left as plain
monospace, because a message can now be a quarter of a megabyte and highlighting
cost is linear in length at best.

#### Lists that count, and why they did not

An ordered list came out with **every item numbered 1**. It looked like a CSS
counter problem and it was not: the parser took a run of *consecutive* list lines
and stopped at the first line that was not one. A blank line between items, an
indented sub-list, or a wrapped second line therefore ended the `<ol>` — and the
next item opened a brand new `<ol>`, which starts counting from one again. A list
written 1 through 8 with any spacing at all became eight lists of one item.

`renderList()` replaced that with a real list parser, one that owns a whole list
rather than a run of lines:

- A blank line inside a list is **spacing**. It ends the list only if the list
  does not carry on below it.
- Anything indented under the current item **belongs to** that item — a nested
  list, a second paragraph, a wrapped line. It is dedented by one level and
  parsed recursively, so a sub-list nests inside its `<li>` instead of breaking
  the parent in half.
- The **first** number is the start (`<ol start>`); the rest are advisory, as
  CommonMark and the reference both have it. That is what makes a list typed
  `1. 1. 1.` render 1, 2, 3.
- A bullet where the numbers were, or a shallower indent, ends the list — that is
  a different list, not this one's to consume.

The inline set matched the reference at the same time, because "keep the
markdown" and "get the markdown right" are the same request: `***bold italic***`
(the two-star rule used to take it and leave the odd star behind),
`__underline__`, `_italic_` with a word boundary so `snake_case_names` survive,
` ``code`` ` spans, `# ## ###` headings, `-#` subtext, and `>>>` to quote
everything that follows. A blockquote's contents go back through the block parser,
so a list inside a quote is still a list. `test/markdown-render.test.js` covers
all of it against the real renderer.

#### There is no character limit

The composer capped at 2000 characters, which is the reference's limit rather than
anything this app needs — and it made pasting a transcript in impossible: the
paste stopped dead partway through with no explanation and no way to finish. Every
composer is uncapped now (main, thread, and the inline edit box), and the only
limit left is the server's `MAX_BODY` at **250,000 characters**. That number is
not a style choice: D1 refuses a row larger than 2,000,000 **bytes**, and 250,000
characters is under it even if every one of them is a 4-byte astral codepoint.

Over it the server answers **413 with the count**, rather than slicing. Silent
truncation was the old behaviour, and it is the worse failure: the message arrives
on the board with its ending missing, and the sender's own screen shows the whole
thing until the next refresh replaces it. Both clients already surface a server
rejection on the queued row with *Retry* and *Discard*.

Three things had to change for a body that size to be survivable, none of them
obvious from the limit:

- **The row signature** contained the whole message text, and `messageSig` runs
  for every row on every render. At 2000 characters that is free; at 250,000 it
  is a quarter of a megabyte copied and escaped per row per poll. Long bodies are
  fingerprinted instead — length, both ends and a rolling hash.
- **Autosize** reads `scrollHeight` after `height: auto`, which forces Chromium to
  lay out the entire textarea, on every keystroke. Past 6000 characters the answer
  is always "the maximum", so the measurement is skipped rather than cached.
- **The offline queue** is persisted to `localStorage`, and fifty quarter-megabyte
  messages do not fit in its quota. A quota failure used to lose the whole queue;
  it now sheds the oldest entries and keeps the newest, which is the rule
  `OUTBOX_MAX` already applies.

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

  The diff walks a cursor along the existing children and advances it only when
  it lands on the node it wanted, so **rows that are going away have to be
  removed *before* that walk, not after it**. Left in place, one doomed node —
  a deleted message, a row that dropped out of the retained window — blocks the
  cursor permanently, and every row after it gets `insertBefore`d past the
  obstruction. The list still comes out correct, which is why this went
  unnoticed: it just cost 400 node moves and 26 ms of forced layout (measured in
  Chromium) to express a single removal. `test/render-diff-cost.test.js` asserts
  the mutation count rather than a duration, because the count is the thing that
  causes the dropped frame and a millisecond threshold is a flake.
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
away, a banner fades in over the bottom of the column — **You're Viewing Older
Messages**, with **Jump To Present** attached to its right and a badge for the
messages from other people since the reader was last caught up. Past 4000 px it
jumps instantly rather than animating through thousands of messages.

That banner replaced a lone right-hand button, which named the action but never
the state: a channel you had simply scrolled up in looked identical to one with
nothing new below. Three things about it are load-bearing:

- **Only the button is clickable.** The banner is a label. Making the whole pill
  clickable means a stray click while selecting its text throws the reader back
  to the live edge — exactly what they were avoiding by scrolling up.
- **It is centred with a `left: 50%` / `transform` pair, so it needs
  `width: max-content`.** Absolutely positioned with `left` and no `right`, the
  shrink-to-fit width is measured from the centre line to the right edge — half
  the column — so the label ellipsised to `You're Viewing Old…` on a window with
  room to spare. For the same reason `.show` re-states the full transform:
  `transform: none` would throw the `-50%` away and the banner would jump half
  its own width as it faded in.
- **`#messages-wrap` is a size container**, so the label can drop below 420 px
  and leave the button (and the count) rather than ellipsise to `You'r…`. A
  media query cannot answer this — the column's width depends on whether the
  members sidebar is open, which the viewport does not know. Only the inline
  axis is contained; the scroller's height still comes from `flex: 1`.

Retained history is capped at 400 messages, trimmed **only** while the reader is
following the live edge with no filter applied — trimming under a reader who has
deliberately paged back, or who is filtering across that history, would take away
exactly what they asked for. `hasMore` is re-armed when it trims, so the trimmed
page is immediately reachable again via *Load earlier*.

### Going back to a channel you were just in

Switching channels blanked the message column and then waited a full round trip
— the app's single most repeated navigation, and for the whole of it the only
thing on screen was a stray *Load earlier messages* button. What you last saw in
a channel is kept now (five channels, least-recently-used), so the switch paints
in the next frame and the fetch fills in behind it.

The cache is never the source of truth. The request still runs, the merge is
untouched, and the server's answer always replaces what was painted — including
when messages were deleted while you were away. Three things it must not break,
each of which has a test:

- **Scroll.** `renderMessages()` never touches `scrollTop`; the only
  scroll-to-bottom lives in `loadMessagesOnce`. Painting a remembered page
  without re-pinning leaves it at the *previous* channel's offset and then jumps
  when the fetch lands, which is worse than the blank it replaces.
- **The chime.** The alert block asks "which of these are newer than the newest
  id I held before this merge?" A restored page moves that from 0 to a real id,
  so every message that arrived while you were elsewhere would look fresh and
  announce itself the moment you came back. One flag suppresses exactly the
  restored merge and nothing after it.
- **Whose messages they are.** The cache is cleared by `teardownSession()`
  alongside the drafts, for the same reason: the next person to sign in on this
  machine must not open a channel and find a stranger's conversation already
  painted. Rename and delete drop their entry too.

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

**Being offline does not count against the queue's retry budget**, and that is
the distinction the feature lives or dies by. A queued message gives up after a
bounded number of tries, so a body that deterministically makes the Worker throw
ends up in front of the person who wrote it instead of looping forever — but the
retry clock is the poll, which runs every four seconds while the socket is down,
so counting outages spent the whole budget in *thirty-two seconds*. Close a
laptop lid for half a minute and the queue announced that it had given up. Only
an ANSWER from the server counts now, and no faster than once every fifteen
seconds; `net.js` flags a request that never reached anything as `offline` so the
two can be told apart. A timeout is deliberately not `offline` — the request went
out and we stopped waiting, which is the one transport failure where retrying
could duplicate a message.

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

### A DM is a channel message

For a long time it was one only on screen. A conversation has always been drawn
with the channel message component — which is what gave it grouping,
attachments, embeds and the day separator for nothing — but `posts` has
`pinned`, `thread_root_id`, `quote_id` and a reactions table, and `dm_messages`
had none of the four. React, reply, *reply in thread* and pin therefore had
nowhere to write, so each was stripped out of the DM view one branch at a time:

```js
(dm ? '' : '<button class="msg-act" data-act="react" …')
```

Four of those, plus a right-click menu that had *not* been given the same
treatment and went on offering all four anyway, one click away from a *Not
found*. Meanwhile the header's Threads, Notification Settings and Pinned
Messages buttons lived in `#chan-head` and simply did not exist in `#dm-head`.

The fix is not four more buttons. It is that **the four things now exist**:
`dm_messages.pinned`, `.reply_root_id` and `.quote_id`, a `dm_reactions` table,
and a DM half for each channel endpoint — `dm/pin`, `dm/pins`, `dm/react`,
`dm/replies`, `dm/reply-threads` — each shaped identically to its channel
counterpart so no client needs a second renderer. `dm/send` takes `parentId`
and `quoteId` the way `post.js` does.

Three things in the client stopped being duplicated, all by the same move — the
one `#composer` already used:

- **`#conv-actions`** — Threads, the bell and pins as one element, relocated
  into `#dm-actions-slot`. A second set of buttons would need a second set of
  listeners, a second placement routine and a second set of `aria-expanded`
  state, and would be missing a feature within a month.
- **`#thread-panel`** — moved into `#dm-main`. It used to live in `#main` and
  nowhere else, and `#dm-panel` is a later sibling at a higher `z-index`, so a
  thread opened from a conversation drew *underneath* it; the old answer was to
  close the conversation first.
- **`dmAsPost()`** — the row mapper, lifted out of `renderDmMessages` so the
  thread drawer, the pinned panel and the threads popout can all use it. Its
  field names are the *channel's* (`pinned`, `reactions`, `reply_count`,
  `quote`, `thread_root_id`), which is what lets one renderer draw either.

`surfaceKey()` is the other half: a channel is named by its name, a conversation
by `dm:<id>`, and the pinned panel, the threads panel and the notification level
all ask that one question. Notification settings are stored under that key, so
silencing a conversation does not silence the channel behind it — and a `dm:`
key is deliberately kept out of the legacy `mutedChannels` list, which is read
by clients that know nothing about conversations.

Two rules are deliberately **not** copied from the channel:

- **Who may pin.** `pin.js` is admin-or-author because a channel has roles. A
  conversation has none — membership is its entire permission model — and *only
  your own* would make the common case (pinning the address somebody just sent
  you) impossible. So any member may pin anything in it, and `mayPin()` and
  `dm/pin.js` agree on that.
- **Moderator edit and delete.** Moderation is a power over a shared, public
  space. Two people talking privately is not one, and a board admin able to
  rewrite what was said there would be a worse bug than any missing button.
  `dm/message.js` checks authorship as well as membership, and the menu does not
  offer what the server would refuse.

One consequence worth knowing about: since replies are now excluded from the
conversation stream (as they always were from a channel's), the newest message
in a conversation is no longer the newest *root*. Opening a conversation marks
it read up to `MAX(id)` rather than to the last row on the page — otherwise a
thread reply, which always has a higher id, would leave a badge that nothing in
the column could clear.

### Telling a running app about a release

The startup gate below answers "an update exists when you launch". This answers
the other half: an update published while somebody is *using* the app.

It used to be answered badly in both directions at once. Detection was a
three-hour timer, so in practice the update arrived at the next launch and the
*Check for Updates* button in Settings was the only way to learn about it
sooner. And then, having taken three hours to notice, it **restarted the app by
itself** — which is precisely what the startup gate exists to avoid, applied at
the worst possible moment instead of the best one.

**Detection is a push, with a poll behind it.** Publishing a release ends with:

```
scripts/publish-release.js
  -> POST /api/board/release        (bearer RELEASE_TOKEN)
  -> BoardRoom /announce            (broadcast, one allowlisted event type)
  -> { t: 'release', version } to every open socket
  -> each client calls its own updater.checkNow()
```

The nudge is **not evidence**. No client installs anything because the socket
said so — it hands the nudge to electron-updater, which fetches `latest.yml`
from the release and is the only thing that decides what is installable. So the
worst a forged call achieves is making some clients re-check a feed they were
going to re-check anyway. The token is therefore a rate-limiting measure rather
than a security boundary, and it is still required, because an unauthenticated
fan-out to every open socket is a free amplifier.

The announce is **best effort, always**: it runs after the release is already
live, so a missing token, an offline box or a 500 costs the announcement and
nothing else. Behind it, `RECHECK_MS` is five minutes (down from three hours),
and a check also runs on every resync — restored from the tray, woken from
sleep, socket reconnected — which is exactly when a broadcast was missed.

**Applying it is a click.** `scheduleAutoRestart()` no longer installs
mid-session; it emits `waitingFor` and lets the pill offer:

| `waitingFor` | what it means |
|---|---|
| `'user'` | downloaded, nothing in the way, waiting to be clicked |
| `'call'` | downloaded, but a call is running — restarting would drop you out of it |
| `'download'` | clicked, bytes still coming |

`installNow()` answers for all three, which is what makes it one click rather
than one-click-and-then-another: called before the download finishes it sets
`installWhenReady` and `update-downloaded` acts on it. A click during a call
**does** restart — the pill says *Restart now*, and refusing it would be a
button that lies.

A download that **dies** clears `waitingFor` with it. `'download'` is the flag
that greys the pill's button out, and a failed download flips the copy to
*download failed … Try again* — so left set through the failure it drew that
label on a control that would not answer, with the retry reachable only by
clicking the bar around the dead button. The click itself is still remembered
(`installWhenReady` survives the error), so a retry that succeeds installs
without a second press.

Ignoring the pill stays safe: `autoInstallOnAppQuit` is armed at `load()`, so
closing the app applies the update whether the pill was ever clicked or not.
And updates found at **launch** are untouched — the gate installs those before
the window exists, because there is nothing to interrupt yet.

The pill itself is one headline, *Update Available*, across every state that has
something to click. It used to rename itself between "Update available",
"Downloading update" and "Update ready" — three notifications for one event, of
which only the last was pressable. Filled in `--slider` and stretched across the
top rather than the quiet float-coloured card the app narrates with, because
this is the one state that is meant to be noticed, and the whole bar is the
click target.

### One search, two places

A conversation had `#dm-search-input`: a 60-character field that lowercased the
box and ran `body.includes(…)` over the messages already loaded. That is
`text:` and none of the other nine operators, with no dropdown, no **More
filters** and no archive behind it — and no way for any of that to arrive,
because every improvement to the real search went into the other box. The same
divergence as the pins, the threads and the bell, in the one component whose
whole job is to answer questions.

Nothing was re-added to it. It was deleted, and three elements moved:

- **`#search-box`** into `#dm-search-slot` in the conversation header
- **`#search-pop`** into `#dm-head` — the dropdown is `top: 100%; right: 16px`
  against the header holding the box, so it has to travel with it (and
  `#dm-head` gets `position: relative` to be that anchor)
- **`#search-panel`**, the results strip, into `#dm-main`

All three used to sit in `#chan-head` / `#main`, which `#dm-panel` paints over
at a higher `z-index`. That is *why* the second box existed: `Ctrl+F` in a
conversation focused a field nobody could see, so it was special-cased to focus
the other one instead. That special case is gone.

The filtering half needed no new logic at all. `postMatchesFilter()` in
`lib.js` takes a post and knows nothing about where it came from, and
`dmAsPost()` already produces exactly that shape — so `applyFilter()` renders
whichever list is on screen and the one `filter` object narrows both.
`displayedDms()` mirrors `displayedPosts()`, down to the match count on the
box, the suppressed intro and the wording of the empty state.

The archive half is the only part that is genuinely two things, because the
messages live in two tables: `/api/board/dm/search` is the DM half of
`/api/board/search`, returning rows under the same field names so one results
row can draw either. **The permission model is the join** — every row comes
back through `dm_members`, so a search can only ever reach conversations the
caller is in; it is written as a JOIN rather than a subquery so it cannot be
loosened later without somebody noticing.

Three operators mean something local:

- `from:` and `mentions:` offer the conversation's members and its speakers,
  not the whole board. Inside a conversation the only people who *can* have
  written anything are the ones in it, so the roster fallback is skipped —
  otherwise the list is names guaranteed to match nothing.
- `in:` names a conversation rather than a channel, and pins the archive scope
  to it. It carries the name the conversation is listed under, because that is
  what the dropdown offers and what somebody would type;
  `dmThreadIdForLabel()` is the single place that becomes an id.
- The scope toggle says *This conversation* / *All conversations*. The internal
  value is still `'channel'` for "here" — the word the channel endpoint uses —
  and it is **translated** at the request rather than passed through, so the
  DM request does not say `scope=channel` and quietly work.

And a hit **goes where it came from**. Every result carries its own `thread`,
which is already what `dmResultTitle()` reads to put a conversation's name on
the row — so `dmThreadOf()` reads it too, and `jumpToDmMessage()` opens that
conversation before it starts paging back. Without it every hit resolved to
whichever conversation happened to be open: harmless under *This conversation*,
wrong for every row *All conversations* returns. The row named one place and
then refused to go there, paged back through the wrong history, and ended on
"that message is further back than we can jump". `jumpToPost()` has switched
**channel** for exactly this since the archive existed; this is its other side.

`in:` is also answered **locally**, and that is the one operator the shared
matcher cannot answer here. `postMatchesFilter()` resolves it by comparing the
name against a post's `channel`, and a direct message has none — so it rejected
every row in the list. Both the dropdown and **More filters** offer the
conversations you are in, the one on screen included, so picking it emptied the
column ("No loaded messages match these filters") while the archive panel
underneath went on returning hits from that very conversation. `displayedDms()`
answers it instead, where the conversation's identity is known: the loaded
messages *are* this conversation's, so the operator passes when it names this
one and matches nothing when it names another — the same thing `in:` means in a
channel, and the same thing an unresolvable name means everywhere else in the
box.

And the **match count on the box** belongs to whichever list is being searched.
There is one `#search-box` and it moves, but the channel column behind the panel
keeps polling and repainting on its own timer — so `renderMessages()` used to
stamp the channel's count over the conversation's a few seconds later, about a
list nobody could see. It writes the count only while no conversation is open;
`renderDmMessages()` owns it the rest of the time.

### One picker, two layouts

Group conversations were already built end to end before there was a decent way
to start one: `dm_threads.is_group` and `dm_members` on the server,
`dm/create` taking a list of users, `dm/manage` for add / rename / leave, the
group header with its Add People and Leave Group menu, `.dm-group` rows with a
stack of faces in the sidebar, and a ten-person cap enforced by *both*
`dm/create.js` and `dm/manage.js`. What was missing was the front door.

So the **New Message** modal is not a new modal. `#dm-picker` has three modes
and two layouts:

| mode | layout | what it answers |
|---|---|---|
| `create` | palette | *where do I want to go?* — channels, conversations and people, keyboard-driven |
| `new` | roster | *who am I messaging?* — the New Message dialog, off the **+** |
| `add` | roster | the same dialog, pointed at a group that already exists |

They share the element, the selection `Set`, the member directory, the
in-flight guard on Create (a group create is **not** idempotent server-side, so
a double-click used to make two identical groups) and the create path itself.
`paintDmPickerChrome()` is the only thing that reads the mode: it swaps the
layout class, moves the head, and writes every label. Splitting them into two
dialogs would mean two places holding the cap, the dedupe and the guard — and
the whole of the DM-parity work above exists because two implementations of one
idea drift.

The head — title plus subtitle — is **moved** between above the card (palette)
and inside it (roster), the same one-element trick `#composer`,
`#conv-actions` and `#thread-panel` use. There is exactly one
`#dm-picker-title` in the document.

Two adaptations away from the reference, both because this app is one board
rather than a network of servers:

- The list is **board members**, not friends. There is no friends system here,
  so a line offering "friends or server members" would name a feature that does
  not exist.
- The two identity lines are the **display name this install is posting under**
  (from presence, when the roster has seen them) over the **account username**.
  This board has no separate profile name — the account username *is* the
  display name — so when presence knows nothing, both lines are the account,
  which is exactly what the reference shows for somebody who has not set a
  display name either.

The cap is counted as *already in the conversation + ticked*, not *me + ticked*:
in `add` mode the second reading let you tick five more people into a group of
eight and find out from the server.

The palette's **Jump to** rows act rather than select, and the two kinds act
differently: a channel row calls `switchChannel(name)`, a conversation row calls
`openDm(thread)` — the row the thread list already hands out, never its id.
`openDm()` reads the id, the title, `isGroup` and the members straight off that
object, so a bare number left all four `undefined`: the conversation opened
titled "Conversation", `dm/list` was asked for no thread at all, and no row in
the sidebar could mark itself as the open one. It is the only way into a
conversation that is not a click on the conversation itself, which is why it
went unnoticed for six releases.

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

### Everything that floats comes down with the session

`#dialog`, `#lightbox`, `#picker`, `#notes`, `#dm-picker`, `#popover`,
`#profile-card`, `#filters-modal`, `#settings` and `#ctx-menu` are **siblings** of
`#app`, not children — so hiding `#app` does nothing to any of them. An expired
session left whatever was open drawn over the sign-in form, and several of them
are focus-trapped, which is the half that cannot be clicked past: `trapFocus()`
early-returns for an element it already holds, so a trap that is never *released*
quietly disables focus management for every later open of that overlay.

`closeFloatingUi()` is the one place that answers for all of them, and it is a
list, so it too went stale: the **profile card** arrived after it was written and
was never added. A session that ended with somebody's full profile open left
their name and face over the password field with Tab confined to the card. It
also takes the private note on that card with it — the field is debounced by
400 ms, and closing is what flushes it.

Two of the entries are not cosmetic at all. The input panel's level meter holds
its own `getUserMedia` stream — the *third* microphone in the renderer, after the
call's and the mic test's — and the connection panel repaints on a three-second
interval that nothing else clears, so every session used to leave one more
running. `test/session-teardown.test.js` covers the set.

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

One thing a reconnect has to say again: **that you are in a call**. The Durable
Object keeps its voice roster per SOCKET, in that socket's attachment, and
`hello` deliberately carries no voice state — while `sendVoice` only fires from
the voice engine's `onState`, which runs when the call state *changes*. So every
reconnect during a call silently took you out of everyone else's realtime voice
list, while the five-second HTTP heartbeat kept putting you back: clients replace
their roster from whichever source answered last, so the person flickered in and
out of the call for as long as it ran. The renderer re-announces on the first
status event of a fresh connection.

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

**Range requests reach the server.** Chromium's media loader opens every
`<video>`/`<audio>` with `Range: bytes=0-` and issues a fresh range request for
each seek — the `lounge://` scheme is registered `stream: true` precisely so it
can. The protocol handler used to drop that header and rebuild the response with
a content type and a cache header of its own, throwing away the server's 206,
`Content-Range` and `Accept-Ranges` — so every attachment arrived as one opaque
200 from byte zero and a media element with no seekable range clamps every scrub
to the start. A long voice message or a screen recording could only be played
straight through, in an app that advertises 1 GB attachments. The range now
travels up and its answer travels back down, with `Content-Length` **derived
from `Content-Range`** rather than forwarded: fetch has already decompressed the
body while the upstream header still counts the compressed bytes, which is what
used to truncate everything Cloudflare gzips.

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

### The update happens before the app does

An update used to land *on* a running app: it started normally, checked the feed
a few seconds later, downloaded in the background and then restarted out from
under whatever you were doing. Everything about that was right except the order.
By the time it applied you were signed in, in a channel, possibly mid-sentence —
and the restart threw all of it away to deliver a version you would happily have
waited four seconds for at launch.

So the check now runs **in front of the window**. `app.whenReady()` awaits
`updater.startupGate()` and builds nothing — no window, no tray, no socket, no
session — until it answers one of two things:

| answer | what `main.js` does |
| --- | --- |
| `'launch'` | build the app, as always |
| `'installing'` | build **nothing**; `quitAndInstall` is already running |

While that is happening there is a small always-on-top-of-nothing window
(`src/renderer/updating.html`) showing the phase, the version and a real
percentage. It is a **separate window with its own preload**, and that is the
point: the app window is the thing being held back, so drawing this inside it
would mean loading `index.html` and letting `boot()` start asking the board who
we are — exactly the startup the gate exists to precede. Its bridge carries one
inbound channel and cannot invoke anything (see `splash-preload.js`, and the
assertions on it in `test/ipc-contract.test.js`).

Three details are deliberate:

- **The screen is lazy.** The usual answer is "you are up to date" and it arrives
  in a few hundred milliseconds, in which case the window is never built and
  launch looks exactly as it did before. It appears when there is genuinely
  something to watch, or after `SPLASH_AFTER_MS` when a slow check would
  otherwise leave a shortcut that seems to have done nothing.
- **A login-item launch stays silent.** `--openAsHidden` / "start minimized"
  still gates and still updates first — it just draws nothing, because popping a
  window at somebody Windows started you for is worse than the update.
- **The app must always start.** Every failure — offline, a feed that never
  answers, a stalled download, an error mid-stream — resolves `'launch'` on a
  deadline (15 s for the check, 5 min for the download). Nothing is lost by
  giving up: `autoInstallOnAppQuit` is armed and the in-session flow picks the
  same update up on its own. A gate that can strand someone outside their own app
  is worse than an update that waits for the next launch.

Two smaller consequences. `checkOnLaunch()` no longer performs the launch check —
the gate already asked, and its answer is what let the window exist — so it only
arms the three-hourly recheck, *unless* the gate gave up without an answer, in
which case it does ask rather than leaving the app three hours from its next
look. And `showWindow()` refuses to build the app window while the gate is open,
because a second launch or a tray click would otherwise conjure the whole session
out from under an update that is still applying — and it keeps refusing for the
half-second after the gate answers `'installing'`, because `gateOpen()` goes
false the instant the gate settles while this process is still sitting in front
of `quitAndInstall`, with no window, no tray and no session.

### Editing

The inline editor has to survive the background poll — `renderMessages()` rebuilds
the whole list, which would rip a half-typed edit out from under you, so it
returns early while an edit is open and resyncs when the edit finishes. A failed
save keeps the editor open with your text intact rather than discarding it.

### Roles and permissions

Three tiers, and **one table** that decides everything:

| | Member | Admin | Owner |
| --- | :-: | :-: | :-: |
| Edit / delete **your own** messages | ✓ | ✓ | ✓ |
| Edit / delete / pin **anyone's** messages | | ✓ | ✓ |
| Create a channel | | ✓ | ✓ |
| Rename a channel | | ✓ | ✓ |
| Remove someone from a call · remove anyone's custom emoji | | ✓ | ✓ |
| **Delete** a channel | | | ✓ |
| Ban · reset a password · clear 2FA · delete an account | | | ✓ |
| Change roles | | | ✓ |

The shape of it: **Admin moderates content and the channel list; Owner is the only
role that touches an account.** Deleting a channel sits with the owner-only powers
rather than the moderation ones because it destroys every message in the channel,
their reactions and their attachments, and cannot be undone.

Four things were wrong before this, and they are worth naming because three of
them were invisible:

- **An admin could demote the Owner.** `/account/manage` was gated on `isAdmin` as
  a whole, so promoting somebody handed them ban, password-reset, 2FA-clear,
  account-delete and role-change over everybody — including the person who set the
  board up, with no way back short of editing the database by hand. The Owner is
  now untouchable by anyone (`mayManage`), and none of those actions is an admin's
  at all.
- **Creating a channel had no role check whatsoever**, server-side or client-side.
- **A moderator could delete somebody else's message but not edit one.** The server
  always allowed it; the hover bar and the right-click menu both gated edit on
  ownership, so the ability existed and could not be reached.
- **Role checks were bare `role === 'admin'` comparisons** spread across the
  Functions and a 12,000-line renderer. "What can an admin do" was not answerable
  by reading anything; it was answerable by grepping and hoping. There is now one
  `CAPABILITIES` table on the server, and a deliberate mirror of it in each client.

> The mirror decides what to **draw**. The server's copy decides what is
> **allowed**, and it is checked on every request — hiding a button is not a
> permission check, and anyone can call the endpoint directly.

The Owner role is established **once**, when the board's first account is created,
and there is no in-app action that grants it. That is what makes it safe: there is
nothing to escalate to. It also means the Owner cannot close their own account —
doing so would leave a board nobody could ever administer.

#### A role change with no restart

A role used to take effect only after the affected person signed out and back in,
or restarted the app, because every client reads its role exactly once — from
`account/me` at startup — and nothing ever asked again. Being promoted and then
having to quit the app to use it is a promotion that has not happened yet.

So `setRole` pushes the change down the realtime socket, addressed by **account**
(the same unicast DMs and voice-kicks use, so every device that person has open
gets it). The client refetches `account/me` — the authoritative answer; the push is
only a trigger — repaints every surface a role decides, and shows a dialog with one
button saying what changed and who changed it.

Two things that had to be got right:

- The message list is diffed by signature, so the viewer's **role is part of each
  row's signature**. Without it the repaint after a promotion appeared to do
  nothing at all: every row on screen kept the buttons it was originally drawn
  with.
- If they are offline, nothing is pushed and the next launch reads the new role
  anyway — which is exactly the old behaviour, and therefore a safe floor.

### Resizable side panels

Both side panels are dragged by their inner edge. The width lands in the CSS custom
property the `#app` grid already uses for its column track, so nothing is
re-laid-out by hand.

**Horizontal only** — the handler reads `clientX` and nothing else, so there is no
vertical drag to start by accident. The handle straddles the edge (8px of hit area,
a 1px indicator until the pointer is on it), is absolutely positioned inside the
panel so it needs no grid track of its own, and disappears with the panel.

The limits are **two**, and the second is the one that matters:

- a static floor and ceiling per panel, so neither can be made unusable or
  overwhelming (`180–480` for the channel list, `160–420` for the members list);
- a **dynamic** clamp that guarantees the message column keeps 420px whatever the
  window size. A static maximum cannot deliver that on its own — 480 + 420 is
  comfortable at 1900px wide and swallows the entire conversation at 1100px — so
  the clamp reads `window.innerWidth`, and is re-applied on window resize because
  shrinking the window is the other way to reach that state.

Written to settings at the **end** of a drag rather than on every frame: a drag
produces one move event per frame and `settings.set` is an IPC round trip plus a
debounced whole-file write. Double-click resets a panel; the arrow keys move it too
(the handle is a focusable `role="separator"`, so a focus ring that did nothing
would be worse than none).

**Wired once, clamped every time.** `initPaneResizing()` runs from `enterApp()`,
which runs again on every sign-in — and the handles are markup that outlives the
session, so signing out and back in left two sets of listeners on the same three
of them, three after the next. Dragging survived it: the second mover reads the
width the first has just written, sees no change and returns. The keyboard did
not — each duplicate reads that width and adds the step again, so one arrow press
moved the panel two steps, then three, and every settings write was duplicated
with it. The widths are still re-clamped on every entry (a window that changed
size between sessions has to be answered); only the listeners are one-time.

**It has to lose to the menus that hang over it.** `#chan-head` is
`position: relative` with a `z-index`, which makes it a stacking context — so the
search dropdown's own `z-index: 40` is spent *inside* the header and the header's
number is the only one that counts against the rest of the app. At 5 it lost to
this handle's 6: the drag line painted straight through the open filters list, and
because whatever paints on top is what the pointer hits, hovering the list where
the line crossed it grabbed the resizer and a drag there resized the panel. The
header sits at 45 now, clearing the handle, the unread jump bar (25) and the thread
drawer (40) — everything in the two columns the header spans and the menu hangs
over. Nothing inside those columns can overlap the header itself; they start below
it.

### The channel header's two popouts

The bell and a new Threads button beside it, in the reference's order — threads,
bell, pins, members, then search.

**Notifications** is the reference's menu: *Mute Channel* with a hover submenu of
durations, a rule, then the three levels as radios on the trailing edge. Two
things about it are decisions rather than markup:

- **A mute is a second axis, not a fourth level.** The level says what a channel
  is normally worth hearing about; a mute says "not for the next three hours"
  without throwing that away, so coming off mute restores whatever the level
  already was. `channelMuteUntil[name]` is an epoch ms, or `-1` for *until I turn
  it back on* — a distinct value rather than a timestamp a century out, because
  "no expiry" is a different thing from "an expiry nobody will reach".
  `channelMutedNow()` is deliberately **read-only**: it is called from renders and
  from the alert check, neither of which may write, so a separate 30-second sweep
  prunes what has expired and says so.
- **"Use Category Default" is absent.** This board has no channel categories, so
  it would be a fourth radio meaning exactly what the first one means.

The header bell used to open the channel's whole context menu, rename and delete
included, which is not what a bell in a header means. That menu is still on the
channel *row* and its right-click, where it belongs.

**Threads** lists every thread in the channel from `/api/board/threads` — a new
endpoint, because both clients could only ever half-derive this from the page they
happen to hold (a root carries `reply_count`), so a thread nobody had scrolled
back to was missing from a panel whose whole claim is to list them all. It
aggregates in one statement rather than a count per root; the local derivation
survives as the offline fallback. Centred over the conversation rather than hung
off the button: the panel is 528px and the button is near the right edge of a
window that can be 900px.

*Create* is **adapted, not copied**. A thread here hangs off a message and there
is no such thing as an empty one, so Create asks for the opening message, posts
it, and opens its thread. That is what "start a thread" means in this app, and it
is real — the alternative was a button that could not do anything.

### Settings: Accessibility and System

Two new panes, plus the switch-and-radio vocabulary the reference uses, applied
across Notifications and Account.

Everything in Accessibility **does something**, and the tests assert what:
`--chat-fs` (a 12–24px slider now, not four names — `store.js` seeds it from the
old scale once), `--msg-gap`, `data-ui-density`, `.desat` + `--sat`,
`.high-contrast`, `.no-motion`, `.underline-links`, `aria-live` on the
conversation, and `webContents.setZoomFactor` for zoom. Two details worth keeping:

- **Saturation is skipped entirely at 100%.** A CSS filter creates a containing
  block, so leaving `saturate(1)` on would change how `position: fixed` resolves
  for every descendant, for no visual gain. It is also applied to `#app` and each
  floating surface separately rather than to `<html>` — and *undone* on images and
  video, because the reference is explicit that it does not touch user content.

  A filter also makes the element the **containing block for its `position: fixed`
  descendants**, which is why the surfaces are listed rather than filtered from the
  root — and four of them were on the wrong side of that line. `#me-popover`,
  `#mic-pop`, `#spk-pop` and `#conn-pop` were children of `#app`, are all
  `position: fixed`, and are all placed from `getBoundingClientRect()`, which is
  viewport-relative. Measured in a real renderer: with the slider anywhere below
  100% they were drawn 31px lower than asked — one title bar, and more again with
  the update pill showing — and every one of them opens *upward* out of the bottom
  bar, so it came down over the control that opened it. They are siblings of `#app`
  now, like every other floating surface, and `test/e2e/fixed-panels.spec.js`
  launches the app and measures them, because jsdom does no layout and 1,100 unit
  tests could not see this.

  Applying it surface by surface makes it a **list**, and a list goes stale. This
  one had: the **title bar** (on screen at all times, and holding the realtime dot
  in green, amber or red), the **update pill** (deliberately the most saturated
  thing in the window when it has something to offer — and it sprang back to full
  colour under the pointer, because `filter` is one property and its own hover
  brightness *replaced* the saturate rather than adding to it), and the
  **profile popover** (the only floating surface with neither `.overlay` nor a
  bespoke selector of its own, carrying a presence dot, a generated avatar hue and
  a red Block). `test/palette.test.js` now matches the selector list against
  `index.html`, so the next surface added to `<body>` cannot slip through the same
  way. The title bar is filtered through its *contents* rather than as itself: it
  is the element carrying `-webkit-app-region: drag`, and "almost certainly fine"
  is not a trade worth making for a colour when the failure mode is a window that
  has quietly stopped being movable.
- **The sliders are all drawn by one function, and have to be.** `--fill` means
  two different things in two stylesheets — the audio popovers paint two
  background layers from a plain percentage, while the settings sheet hard-stops
  a gradient at a **thumb-centre length** (`thumbAt()`, which exists because a
  naive percentage runs ahead of the thumb at the low end and behind it at the
  high end by half the thumb's width). Voice & Audio's three were painted with the
  popover's unit, so the filled half of the track stopped up to 8px away from the
  handle it is supposed to end under, and none of their tick labels was ever lit —
  a scale that read as decoration beside four in Accessibility that all name the
  value they are on.
- **Compact is two halves, and both have to name every list.** *Chat Message
  Display → Compact* is delivered by the stylesheet (hide `.msg-gutter`, lay
  `.msg-head` out inline) **and** by the renderer refusing to group, and neither
  half works without the other: a grouped row has no `.msg-head` at all, so once
  the gutter is gone it carries nothing identifying it. `renderMessages()` passes
  `null` for `prev` in compact for exactly that reason.

  Three lists draw `.msg` rows — `#messages`, `#thread-list` and `#dm-messages` —
  and each half had missed a different one. `applyDensity()` has put `.compact` on
  `#dm-messages` since a DM became the same row as a channel post, with the express
  purpose of stopping the conversation staying cozy while the channel went compact;
  the stylesheet never named it, so the setting did nothing there. `#thread-list`
  *was* styled and grouped anyway, which is the worse of the two: its gutter is
  `display: none`, so a run of replies from one person drew as naked text with no
  author and no time. `test/message-density.test.js` asserts what each list grouped
  in both densities, and matches the density block's selectors against all three
  lists — the failure mode is a missing selector, not a wrong value, so it is
  checked as text.

  Density is therefore not just a class, and `applyDensity()` has to **repaint**
  the two lists that will not repaint themselves. The channel column is fine —
  every caller follows with `renderMessages()`, which diffs by a signature that
  already carries the density — but `renderThread()` and `renderDmMessages()`
  rebuild wholesale from polls that short-circuit on an unchanged payload
  (`loadThread` and `loadDmMessages` both compare a signature first). Flipping
  the setting with a conversation or a thread open therefore applied the new
  class to rows that were grouped under the old one, and left them that way
  until somebody happened to say something. Both repaints self-guard on being
  open, and both drawers are `hidden` in the markup, so the `applyChrome()` call
  during startup reaches neither.
- **The live Preview is the real renderer.** Two fixed messages through
  `renderMessage()`, so the markdown, the link and the reactions are the same code
  the conversation uses — a slider can be dragged while watching what it actually
  does. Built when that pane is shown, not kept in sync behind a closed sheet.
  They are rendered as **two groups**, each with its own author header: passing
  the previous post let `renderMessage` group them (same author, seconds apart),
  which put both under one header and left "Space Between Message Groups" with no
  gap to move. Beside them sit the two things the reference demonstrates there and
  the message column has no use for — a stack of three status faces, each a colour
  **and** a shape, and the app's own primary button at the current text size. The
  username is role-coloured (`--preview-role`) for the same reason: a coloured
  name is one of the things this pane is asking about.

System is the old Behaviour pane in the reference's shape, plus **hardware
acceleration** — the one setting Chromium can only be told about before the app is
ready, so it says a restart is needed and offers one instead of appearing to take
effect. Its Custom Keybinds are the *same* bindings Voice & Audio records:
`bindKeyRecorder` takes a list of buttons now, so two panes cannot show different
keys for one hotkey. **Default Keybinds** lists only shortcuts the app really
implements — written from the handlers, not from memory.

There is no System Helper (the reference's is an update service; this app's updater
needs no configuration), no Email notifications pane (this board sends none), and
nothing about Nitro, billing, phone numbers, categories or other servers. A pane
of toggles that control nothing is worse than a missing pane.

Each tab also lists **its own headings** in the rail while it is open. A heading
inside a block this viewer cannot see — *Members* is the owner's only — is dropped
from that list, and the check walks the DOM for `hidden` rather than asking the
layout: `offsetParent` is the obvious test and it is null for everything in jsdom,
which would hide every sub-entry under test while looking correct in the app.

### Spellcheck

The underline was never the hard part. `webPreferences.spellcheck` is on, so
Chromium has been marking misspellings in the composer since the app existed —
and on Windows 10+ Chromium uses the **OS** spellchecker, which means no Hunspell
download from Google's CDN, no network dependency, and it works offline. The
languages default to the OS locale rather than being pinned, so a machine set to
French is checked in French.

What could not be done was offering the **corrections**, and the reason is worth
writing down because it is invisible:

> The misspelled word and its suggestions exist **only** on the main process's
> [`context-menu`](https://www.electronjs.org/docs/latest/api/web-contents#event-context-menu)
> event — and that event does not fire if the renderer cancels the DOM
> `contextmenu` event. A cancelled `contextmenu` stops Blink asking the browser
> process for a menu at all.

The composer drew its own styled menu from a DOM handler that called
`preventDefault()`, which is exactly that. So the red squiggle was a dead end:
you could see that a word was wrong and there was no way to ask what it should
be. Nothing errored; the feature simply had no path to the surface.

So the flow is inverted. The renderer no longer opens the menu for a text field —
**main tells it to**, pushing everything the menu needs with the click:

| from `params` | what it's for |
| --- | --- |
| `misspelledWord`, `dictionarySuggestions` | the corrections, from the same spellchecker that drew the underline, so the menu can never disagree with it |
| `editFlags` | Chromium's own answer to "is there a selection to cut, is there anything to paste, is there anything to undo" — it knows about image data, and it arrives with the event, so the menu no longer waits on a clipboard round trip |
| `x`, `y` | CSS pixels relative to the page, i.e. exactly `clientX`/`clientY` |

The menu that comes out of it is the standard one, in the standard order: the
suggestions first (**all** of them, each its own item, bold because the label is a
word that will be inserted rather than the name of a command), *Add to
dictionary*, then *Undo* / *Redo*, *Cut* / *Copy* / *Paste*, *Select all*. The
spelling half appears only when a misspelled word was actually right-clicked;
otherwise it is the editing commands alone. Undo and Redo run Chromium's own
commands, so the menu and Ctrl+Z drive the same stack — including for a spelling
correction, which goes *through* the editing pipeline rather than around it.

#### One Chromium switch does the rest

There is a second reason the corrections can come out empty, and it has nothing to
do with the DOM event. On Windows 8+ Chromium spellchecks through the OS, and
behind the `WinRetrieveSuggestionsOnlyOnDemand` feature it deliberately leaves the
corrections **out of the spelling markers** — Chrome's own context menu fetches
them afterwards, asynchronously, once it knows a menu is being built. Electron has
no equivalent: `context-menu` hands over the raw `ContextMenuParams` and that is
the only chance to read them. With the feature on you get a `misspelledWord` and
an **empty** `dictionarySuggestions`: the word is flagged, the underline is drawn,
and there is nothing to offer.

Whether it is on is a Chromium field trial, which is to say it varies between
machines and between runs — not something to leave to chance for a feature whose
failure mode is showing nothing. `app.commandLine.appendSwitch('disable-features',
'WinRetrieveSuggestionsOnlyOnDemand')` pins the suggestions inline. Verified both
ways against a real Electron process: "toulp" answers *tool, tolu, toil, tools,
Toul*, which is what Chrome shows for it too.

Picking a suggestion runs Chromium's `replaceMisspelling` editing command rather
than splicing the string here. That is what makes it act on the selection already
on screen (right-clicking a flagged word selects it), fire a real `input` event —
so autosize and the send button update themselves — and land on the undo stack,
so Ctrl+Z takes the correction back.

Two consequences worth knowing:

- **Every** editable field gets the menu, not just the composer, because
  `isEditable` is the only thing main can tell them apart by. That is the right
  answer anyway: "a text field you cannot paste into" is the bug this menu was
  added to fix, and it was equally true of the thread composer, the edit box and
  the search field.
- A `preventDefault()` added to a text field's `contextmenu` in future would
  silently kill spellcheck again. `test/e2e/spellcheck.spec.js` asserts that main
  sees the right-click, which is the only thing that catches it.

`test/spellcheck-menu.test.js` covers the menu the renderer builds from that
push; the e2e spec covers the parts jsdom cannot see — that the event fires, that
Chromium really flags a typo, and that the replacement edits the textarea.

### Pinned messages

Pins used to be an inline banner between the header and the conversation, and it
was wrong in three ways at once: it pushed every message down while it was open,
it had room for one truncated line per pin, and it stayed until it was dismissed.

The pin button opens a **popover** now — *Pinned Messages*, one card per pin, each
with the avatar, the name, the full date-and-time stamp and the whole message body,
with *Jump* revealed on hover. Details worth knowing:

- The body goes through the same `renderBody()` the conversation uses, so a pinned
  list, a pinned code fence or a pinned mention reads the way it does in the
  channel. The banner escaped the text and cut it at 240 characters.
- The stamp is date **and** time. A pin sits outside any day divider, so a bare
  clock reading does not say which day it belongs to.
- It is `position: fixed` and lives at the end of the document rather than inside
  `<main>`, because a 520 px popover hanging off a 40 px header would be clipped
  by the column's overflow. `placePinned()` anchors it under the button, right
  edges aligned, and clamps it on screen — re-measured *after* the cards exist,
  since an anchor computed against the empty box lands in the wrong place.
- It closes the way a popover has to: the X, Escape, a click anywhere outside, and
  a channel switch. The banner did none of those, which is also how it went stale
  — it hard-coded the channel it was drawn for and sat over the next conversation
  still listing the previous one's messages.
- *Unpin* is still there, on hover next to *Jump*, and still gated on `mayPin()` —
  admin-and-above for somebody else's message, which is what the server enforces.
  A click on either control does not also jump: being yanked away on the way to
  removing a pin is not what the click meant.

### The new-messages bar

*"12 new messages since 12:38 AM on March 21, 2026"*, in the reference's brand
blurple across the top of the channel, with *Mark As Read* on the right.

The tracking it needs already existed. `reads` is the per-channel map of "the
newest post id I have seen", kept **per account** in `localStorage` and posted to
`/api/board/channels`, which is what computes the sidebar's unread badges. What did
not exist was that value at a moment when it is still useful: `loadMessagesOnce`
stamps `reads[channel] = maxId` on every load of the channel on screen. That is
right for the badge — looking at a channel reads it — and it destroys the only
record of where the reader had got to.

So the watermark is captured **on the way in**, before the first load of the
channel can overwrite it: at launch after the channel list lands (which is also
when the server's true unread count for that channel is known, counted against the
watermark that went out with the request), and in `resetChannelView()` on every
switch. It is then held for the length of the visit.

- The count is `max(what the loaded page can see, what the server counted)`. One
  page is a window; the server's number is the total.
- The timestamp is the **first unread message's**, which is where the reader left
  off.
- The bar is absolutely positioned over the top of the list rather than taking its
  own row: a notice that appears and disappears must not move every message down
  and back up again.
- Clicking it jumps to the first unread message. This app opens a channel at the
  *bottom*, so without that the bar names messages sitting somewhere above it and
  offers no way to reach them.
- It clears when the reader says so (*Mark As Read*, which also stamps the
  watermark at the newest message and refreshes the badge), when they leave the
  channel, and when they **post** into it — writing into a channel is as clear a
  statement of "I have read this" as pressing the button. It deliberately does not
  clear on reaching the bottom, because the channel *opens* at the bottom.
- The reader's own messages never count, and neither does a blocked author's — for
  the same reason the jump badge excludes them: a count that includes messages
  which are never drawn promises something the jump can never deliver.

### Push-to-talk

Electron's `globalShortcut` only reports key *presses*, never releases, so it
cannot drive real push-to-talk on its own. The app uses the optional native hook
`uiohook-napi` (prebuilt, no compiler needed) for true system-wide
keydown/keyup. If that module is unavailable it degrades gracefully: the
accelerator becomes a push-to-talk *toggle*, and hold-to-talk still works
whenever the window has focus.

**Settings says which of the three actually happened.** `apply()` answers
`{ mode, bound }` — `'native'` is real hold-to-talk, `'toggle'` means a global
accelerator was registered instead (a LATCH, and taken off every other
application while the app runs), `'none'` means neither could be arranged — and
every call site threw that answer away. The hint underneath the key asked
`available()` instead, which is only "did the module load", a question ptt.js's
own comment says is not the same as "does the hook work": `start()` throws when
the OS refuses the low-level input hook, so a machine that had silently fallen
back to the latch was told "works system-wide", and one whose binding no
transport could carry was told the same while nothing was bound at all. The hint
is painted from the cached result of the last `apply()` now, and names the chord
it is holding off other apps when it is holding one.

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

That second tap has a sharp edge, and the tray says so now. Transmission is
gated by `disableAudio()` rather than by a gain node (see *Voice settings that
are deliberate*), so while you are muted — or in push-to-talk with the key up —
the track the mix feeds is genuinely stopped and the clip reaches nobody. The
local tap still plays it, which made that indistinguishable from a clip the
whole call heard: the button flashed, the sound played, and nothing went out.
Pressing a clip while you are not transmitting now says which of the two it was.

### The search box is the state

There used to be two searches. A field in the header, and a row that dropped in
under the channel header when you pressed it — with its own input, its own scope
toggle, its own filter menu and its own chips. Two boxes filtering the same list
in two different ways, neither aware of the other. The row is gone.

What is left is one string. `from:alice has:link before:2026-01-01 lunch` is a
query and three filters, and the string is the source of truth for all of them:
the dropdown does not keep filters beside the box, it **writes operators into
it**. That is the whole design, and it is what makes "typeable as well as
selectable" true by construction rather than by being implemented twice — there
is only one representation, so clicking and typing cannot drift apart.

Three consequences worth knowing:

- **The operator list is closed.** Anything not in it stays in the text, so a
  message about `http://example.com` or a ratio like `16:9` searches for itself
  instead of vanishing into a filter nobody asked for.
- **A bare `from:` is not a filter.** It is somebody mid-type, and narrowing the
  list to messages from nobody while the dropdown is still offering them a name
  would be the menu fighting the person using it.
- **The operators never leave the machine.** `/api/board/search` understands
  free text and nothing else, so `from:alice logo` asks the server about "logo"
  and resolves Alice here. That is the honest split: the server has no idea who
  Alice is, and the answer is available locally without a round trip.

`from:` resolves a person the way everything else does — the ACCOUNT first, the
display name as the fallback for rows written before accounts existed. A name
the app has never seen still filters, on the name alone, so a typo narrows to
nothing rather than silently matching everyone. The people offered come from the
loaded messages *and* the account directory, because "from: somebody who has not
spoken lately" is a reasonable thing to ask.

`during:` is two bounds, not one — "during the 15th" means the whole of that
day — and the parser takes `YYYY-MM-DD`, `YYYY-MM` or `YYYY`. Anything else is
ignored rather than guessed at: a filter built from a misreading is worse than
no filter.

**More filters opens a form, not more menu.** The extra criteria are a
different shape of question — a date, a role, a channel — and a dropdown that
answers by growing eight more rows is a list you scroll past rather than a
thing you fill in. So it opens a centred modal: From, In, Has, Mentions, Date,
Author Type and Pinned, each with a label and a line saying what it does, over
a Clear Filters / Cancel / Apply Filters footer.

It holds no state of its own. It **reads the box on open and writes it on
apply**, which is what stops it from ever disagreeing with what has been typed:
Apply is a shortcut for typing the operators, exactly as the dropdown rows are.
Three consequences:

- **Cancel really cancels**, and so does Clear Filters on its own — the fields
  are just fields until Apply is pressed.
- **Apply keeps the free text and any operator the form has no field for.**
  Setting `Has` on `from:alice logo` leaves both of the others where they were.
- **The trailing space Apply leaves is load-bearing.** Trimmed, the caret lands
  *inside* `from:alice`, so clicking back into the box offers people rather than
  the filter list — and there is no way back to More filters without typing a
  space nobody would think to type.

**Author Type** is the one field that could not be copied. The reference offers
Bot and User; this board has neither, so it means the distinction that does
exist here — You, Admins, Members — resolved against the account directory into
the same identity shape `from:` uses, which is why it needed no matching logic
of its own.

### Offline is the absence of a row, which is why it needed a second source

The presence table can only ever answer *who is here*. Somebody offline has no
row in it — that is what offline means — so the member list had no way to show
them at all, and simply didn't. The answer has to come from the other
direction: the **account directory** (`account/users`) minus whoever is
currently present. That list changes when somebody registers, which is a handful
of times a year against a presence poll every twenty seconds, so it is loaded
once at startup and refreshed on the same five-minute sweep the avatars use.

Two rules keep it honest. A **banned** account is in neither list. And **you**
are never listed as offline to yourself: Invisible works by retiring your
presence row, so your own client would otherwise find you in the directory,
find you nowhere in presence, and file you under Offline — the setting working,
rendered as the app being broken.

Grouping follows the reference: Idle and Do Not Disturb sit *inside* Online,
told apart by the colour of their dot. They are here, just busy or away from the
keyboard. Only Offline is separated out, and only Offline is faded — dimming
somebody idle said the opposite of what their yellow dot said.

**Told apart by the colour of their dot** is a claim the stylesheet has to keep,
and in one place it did not. Six surfaces draw a presence dot from the same
`statusDot()` / `presenceDotClass()` expressions; five of them had a rule for
every answer, and the per-participant popover had `idle` alone — so its base
green stood for Do Not Disturb *and* for Offline. Clicking somebody in the
Offline section opened a panel calling them online, an inch from the grey dot on
the row it had just opened from. That is the exact complaint `openPopover()`'s
`known` argument was added to fix: the JS had been passing `'offline'` the whole
time with nothing to draw it. `test/palette.test.js` now checks every dot family
against every state it can be handed.

### The wire says `away`. Everything else says Idle.

The presence table is **shared with the website**: both clients write it and
both read each other's rows, so renaming the value would split one member list
into two that disagree about the same person. It stays `away` forever.

So the translation happens in exactly one place — `statusFromWire()`, on the way
in — and nothing past it uses the old word: not a label, not a class name, not a
sort key. `test/offline-status.test.js` pins the boundary from both sides, and
the assertion that matters is the negative one: nothing the member list renders
may contain the string "Away".

### What you chose, and what you are

They differ in exactly one case: you chose Online and the idle rule has since
fired. Auto-idle went out on the heartbeat long before this — so everyone
*else's* copy of you turned yellow while your own dot stayed green, which is the
app disagreeing with itself about the same fact two inches apart.

`effectivePresenceMode()` is what the me-bar and the popover's status row draw
now. The **picker** still checks `presenceMode()`, because that is what a choice
is. And since the idle threshold crosses on a clock with no event behind it, the
presence heartbeat is what notices: it compares the effective mode against the
last one it published and repaints your own dot in the same pass that tells
everybody else.

Closing the app retires the presence row explicitly rather than waiting for it
to age out — `retirePresence()` in main.js, which now runs for any signed-in
quit rather than only a mid-call one, and sends both rows on one budget.

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

Electron on Windows has no system picker, so the app shows its own, and because
it is the *only* chooser it is built like one rather than like a dialog:

- **The categories are the top row** — Applications and Entire Screen, as a
  segmented control. There is no title bar and no X; Cancel, Escape and a click
  on the backdrop are the three ways out, and `trapFocus()` supplies the
  dialog's accessible name.
- **A grid of the sources themselves**, each labelled underneath with the app's
  own Windows icon (`fetchWindowIcons`) and its window title. The tile *is* the
  picture: no plate, no padding, no resting border — a frame around every
  thumbnail turned a grid of screens into a grid of boxes, and the thing being
  chosen is what is inside them. A source that returns no thumbnail (a minimised
  window, a capture Windows refuses) gets a box of its own saying so, because an
  `<img>` with no `src` is drawn as a *broken* image.
- **A selection belongs to the category it was made in.** Switching tabs clears
  it. Carried across, Share could send a window while the grid showed screens,
  with nothing on screen saying which one was armed.

The source is registered with the main process *before* the SDK is told to
share, because `enableScreenShare()` calls `getDisplayMedia()` immediately and
the display-media handler needs an answer ready.

**SD and HD are deliberately not symmetrical.** SD always writes 720p, but HD
only raises a *720p* setting to 1080p and otherwise leaves the value alone —
because the app also supports 1440p, which two buttons cannot express, and
writing 1080p unconditionally would quietly downgrade anyone running at 1440p
every time they pressed the tier they were already on. The gear beside them is
where 1440p and sharp/smooth live; it closes the picker rather than stacking a
second modal on it, because two focus traps deep, Escape unwinds them in the
wrong order.

That handler reads exactly one field off the source — its `id` — but it was
asking `desktopCapturer` for the default thumbnail of every screen and every
open window, ~150 ms on the share's critical path, and throwing all of them
away. It asks for `thumbnailSize: { width: 0, height: 0 }` now. The picker still
requests real thumbnails, because it actually draws them. The lookup itself
stays: a selection can be a minute old (`SHARE_PICK_TTL_MS`), and it is what
turns "the window you picked has since closed" into a clean denial rather than
Chromium capturing a dead handle.

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
