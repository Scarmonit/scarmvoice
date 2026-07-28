# Gap inventory — ScarmVoice against Discord

The work list. Not "make it look like Discord" as a feeling, but the specific
things Discord has that we do not, in an order.

**Scope rule.** Everything Discord does is in scope EXCEPT what exists to sell
something — Nitro, Server Boost, Subscriptions, Gift Inventory, Billing, gifts,
sticker/emoji tiers. Those are the reason this app exists; they are the only
deliberate divergence.

## How to read the confidence column

Matching by hand went wrong before because a note could not be told apart from
a guess. So every row says where it came from.

| mark | means |
| --- | --- |
| **measured** | captured off the live reference this session — labels, sizes and colours are exact |
| **seen** | visible in a screenshot of the reference, not yet measured |
| **unverified** | believed true, NOT captured. Confirm before building. |

---

## 1. Settings

Reference nav captured in full (ends at Log Out). Ours has 9 panes.

| Discord pane | ours | confidence |
| --- | --- | --- |
| Account → Account Info (username, email, phone) | display name only | **measured** |
| Account → Password & Security (change password, **Logged-in Devices**) | 2FA only | **measured** |
| Account → Account Standing | — | **measured** |
| Account → Family Center | — (probably skip) | **measured** |
| Account → Disable / Delete | ✅ **done** | **measured** |
| Data & Privacy | — | **measured** |
| Messaging Permissions | — | **measured** |
| Notifications | ✅ have | **measured** |
| Voice & Video | ✅ have (Voice & Audio) | **measured** |
| Appearance | ✅ have | **measured** |
| Accessibility | — | **measured** |
| System | ✅ partly (Behaviour) | **measured** |
| Language & Time | — | **measured** |
| Activity Privacy | — | **measured** |
| Connected Apps | — (probably skip) | **measured** |
| Developer | — (probably skip) | **measured** |
| *Nitro / Boost / Subscriptions / Gift Inventory / Billing* | *excluded* | **measured** |

Ours with no Discord counterpart — keep, they are ours: Custom emoji, Screen
share, Soundboard, About.

Note: this is the **web** build's nav. The desktop client also carries Keybinds,
Streamer Mode, Game Activity and Windows Settings. **unverified** — capture from
the desktop app before building those.

## 2. Shell chrome

Every control below was read off the live reference by accessible name.

**Channel header** — Threads · Notification Settings · Pinned Messages ·
Show Member List · Search · Inbox · Help

| missing | note | confidence |
| --- | --- | --- |
| **Inbox** | unread/mentions tray. No equivalent at all. | **measured** |
| **Threads** panel | we have thread markup but no header entry point | **measured** |
| Help | probably skip | **measured** |

We have: Pinned Messages, Show Member List, Search, Notification Settings
(`btn-chan-alerts`) — all present.

**Composer** — Add Emoji · Open GIF picker · Open sticker picker · Send a gift ·
Apps · attach

| missing | note | confidence |
| --- | --- | --- |
| **GIF picker** | 3 stray "gif" hits in our markup, no picker | **measured** |
| **Sticker picker** | zero hits | **measured** |
| *Send a gift* | *excluded — paid* | **measured** |
| Apps | probably skip | **measured** |

**User panel** — Mute · Deafen · User Settings · Input Options · Output Options.
All five present. ✅

**Server rail** — Add a Server · Discover · Download Apps.
Discover missing (**measured**); Download Apps not applicable.

**Sidebar header** — "Scarmonit, server actions" dropdown.
We have Invite; the **dropdown itself is missing** (**measured**) — see below.

## 3. Context menus

The server menu was captured whole: 14 items, 192px wide, 8px radius.

> Mark As Read · Invite to Server · Mute Server · Notification Settings ·
> Hide Muted Channels · Show All Channels · Server Settings · Privacy Settings ·
> Edit Per-server Profile · Create Channel · Create Category · Create Event ·
> Security Actions · Copy Server Info

We have `#ctx-menu` with `.ctx-item`, so the mechanism exists — the contents do
not.

**Not yet captured**: message right-click, channel right-click, member
right-click, user-profile popover, message hover toolbar. These need a *trusted*
right-click; the browser extension's synthetic and real clicks both failed to
open Discord's menus this session, repeatedly.

That is exactly what `scenes.cjs` was built for — `page.mouse.click(…, {button:
'right'})` under `spec:ref` **is** a trusted event. It is blocked only on the
one-time sign-in for the capture profile. **Do that first**; it unblocks this
whole section, and it is the largest unmeasured area left.

## 4. Behaviour, not appearance

Named here so they are not lost behind the visual work. All **unverified** —
capture before building.

- Keyboard shortcuts (Ctrl+K quick switcher, Esc mark-read, Shift+Esc, Ctrl+Shift+M mute…)
- Reply / mention semantics: jump-to-message, mention pill behaviour, ping rules
- Unread state: the white bar, "new messages" divider, per-channel bold, badge counts
- Typing indicators, read receipts
- Empty, loading and error states for every surface
- Drag-and-drop upload, paste-to-upload

## Suggested order

1. **Sign in to the capture profile** — unblocks §3, the biggest blind spot.
2. **Settings panes**: Password & Security (change password, logged-in devices),
   then Data & Privacy, Accessibility, Language & Time. Password change and
   device revocation are backend work like removal was.
3. **Server-actions dropdown** — 14 measured items, mechanism already present.
4. **Inbox** — the largest genuinely absent feature.
5. **GIF picker**, then stickers.
6. §4 behaviour, once §3 is captured.

## Done

- **Account disable / delete** (2026-07-28). Backend `account/removal.js`,
  `disabled` column, login restores. Buttons measured to the reference:
  144×40 / 138×40, `#94949c@.12` + `#f87e7a`, `#d22d39` + `#fff`, 8px radius,
  .05s, 16/500 labels.
