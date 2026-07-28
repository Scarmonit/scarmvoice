# Spec capture

The point of this directory: stop describing the reference by hand.

Every round of "make it look like Discord" so far has meant someone opening both
apps, comparing a region by eye, measuring pixels off a screenshot, and writing
it down. That is slow, it is error-prone in both directions — two of the notes
that came back were measurement artefacts, and one was a real bug nobody could
see — and it has to be redone from scratch every time either side changes.

This captures the same information from both apps mechanically, in the same
format, so the comparison is a diff instead of an essay.

## What it captures

Per named component, on both sides:

- computed colour (resolved through a canvas, so `oklab()` and `#hex` compare)
- **the design token that colour IS** — `#121214` reported as
  `--background-base-lowest`, not just as a number
- relative luminance, which is what every "too bright" note has actually been
- box model, and the **ink** extent of any glyph inside it — what the eye
  measures is never the box the icon is drawn in
- font size, weight, tracking, line height, case
- tooltip text
- **real `:hover` and `:active`**, forced over CDP and measured, plus the
  `:hover` rules that apply, read out of the stylesheet
- glyph geometry: viewBox, fill, path data

And once per capture, separately: **the whole token system**. The reference
resolves 4691 custom properties on `:root`, which is what its own rules are
written against — `var(--interactive-background-hover)`, never a hex. Every
colour ever copied off a screenshot was one resolved value of one of these.

## Running it

```
npm run spec:app                 # our side, via dev/harness.html
npm run spec:app -- voice        # a scene: voice, members, settings
npm run spec:ref                 # the reference side — no paste, see below
npm run spec:ref -- contextMenu  # a scene: see scenes.cjs

npm run spec:diff   -- dev/spec/out/discord.json dev/spec/out/app.json
npm run spec:pix    -- dev/spec/out/discord.json dev/spec/out/app.json
npm run spec:tokens -- dev/spec/out/discord-tokens.json dev/spec/out/app-tokens.json
```

`spec:diff` reports properties. `spec:pix` crops the same component out of both
screenshots into a contact sheet — reference, ours, and the two overlaid in
difference — for the half of a difference that has no number: a gradient, where
the ink sits inside its padding, an edge painted on three sides.
`spec:tokens` puts our variables against theirs.

### Capturing the reference

There is no manual step. The previous version of this file said there was:

> Discord's CSP blocks a remote `<script>` and a `fetch` to localhost, so the
> payload has to arrive as literal source. That is the one manual step left.

Half of that is true, and the half that is not was load-bearing. Measured
against the live app:

| delivery | result |
| --- | --- |
| `<script src="http://127.0.0.1:…">` | blocked by `script-src` |
| `fetch("http://127.0.0.1:…")` | 200, 10793 chars |

`script-src` does block the tag. But CSP governs what the **page** may load, and
says nothing about what a driver attached to the browser may evaluate —
`page.evaluate()` and an extension's injected code both run outside it. So the
probe is read off disk and handed to the page, and nothing is fetched by the
page at all.

`spec:ref` connects one of two ways, in order:

1. **An already-running Chrome with a debugging port.** Reuses the session you
   are signed in to. Start it with `chrome.exe --remote-debugging-port=9222`.
2. **A dedicated profile** in `dev/spec/.profile` (gitignored). The first run
   opens headed so you can sign in once by hand; later runs reuse it.

Signing in is yours to do, in the browser window, either way. Neither script
handles a password.

`spec:relay` is a third route for a browser you are already signed in to and do
not want to restart: it serves the probe over loopback and takes the result
back by POST. It prints the snippet to run. It cannot force pseudo-classes —
that needs a driver — so `:hover` comes back as rule text rather than as
measured values.

### Scenes

The shell is what is on screen at rest, and it was always the cheap part. The
expensive part is everything that is not: the right-click menu, the profile
popover, the message hover toolbar, the pinned list, every tooltip, the
settings tree. Each of those used to be opened by hand, looked at, and written
down in prose, once per round.

`scenes.cjs` opens them instead, and then they are just another capture.
`members`, `messageActions`, `contextMenu`, `userCard`, `tooltip`, `pinned`,
`threads`, `emojiPicker`, `settings`, `search`. Each confirms the thing
actually opened, because a scene that silently fails produces a spec full of
`missing` and wastes a round.

## Adding a component

Two lines in `targets.js`: a finder for each side.

Ours is a selector, because we own the markup. Discord's has to be a predicate
against geometry, text or role — its class names are hashed and change on every
deploy, so `.chatContent_f75fb0` is worthless a week later while "the painted
column wider than 40% of the window" keeps working.

If it only exists once something is open, put it under that scene instead of in
the shell.

## Things that quietly poisoned a capture

Kept here because each one produced a confident wrong number, and each was
found by disbelieving the output rather than by reading the code.

- **Every style rule was skipped.** The stylesheet walk tested
  `if (r.cssRules) { walk(...); continue; }`, and Chrome gives *every*
  `CSSStyleRule` a `cssRules` list — empty unless the rule nests, and an empty
  list is still an object. So it recursed into nothing and continued, never
  reading a selector. It reported 0 hover rules against a page that has 1209,
  on both sides, which looked like agreement and was silence.
- **The first match is rarely the visible one.** `messageAuthor` used a plain
  `querySelector`, which returns the first match in the DOM — in a scrolled
  channel, a name 3504px above the top of the window. It came back with a box,
  a colour and a font like any other row.
- **Ink across a scrolling column means nothing.** The glyph extent was measured
  over every SVG in the element, which for a message list is the whole scroll
  buffer: it reported a glyph 4554px tall. Containers now only get an ink figure
  when they hold a single glyph.
- **Nearest-by-luminance is not nearest.** The token comparison first matched on
  brightness alone and every token found a match at distance zero, because
  against 4691 candidates something always shares a luminance. It paired our
  `--elev` (`#343439`, grey) with `--orange-new-72` (`#732700`, brown).
- **Two servers, one port.** The relay defaulted to 8799, which is where
  `capture-app.cjs` serves the harness. Whichever bound first answered, and the
  app capture hung on `HARNESS_READY` with no indication that the reason was a
  busy socket.
- **State captured as appearance.** A muted mic paints its button red. Captured
  that way it becomes "the mute button is red", which nobody can reproduce.
  `capture-ref.cjs` now checks mute, theme, density, font size and zoom before
  it trusts a sweep, and says so.
- **A prompt nobody could see.** The sign-in notice printed only on the first
  poll, and at the first poll the tab is still on `/app` — the redirect to
  `/login` lands a few seconds later. So a run that was waiting, correctly, for
  a human to sign in sat silent for its full five minutes. Both notices now fire
  when their condition is first seen, once each.
- **A second tab, every run.** `findPage()` looked for a channel tab, then any
  Discord tab, then opened a new one — and a persistent context always starts on
  `about:blank`, which is neither. It left the blank tab behind on every run.
- **A killed process group reports as `Page crashed`.** Running the reference
  capture under `timeout` produced "Page crashed" at 21s, 36s and 50s against
  timeouts of 20s, 35s and 50s. The runner was fine and waiting for a sign-in
  that was never going to come from a test harness. Before believing a crash,
  check whether the failure time equals the timeout.

## What it will not tell you

- **Whether a difference is worth copying.** Blurple sliders, DMs in their own
  view, an end-to-end-encryption badge we cannot honestly display — those are
  decisions, and the diff has no opinion.
- **Whether the reference is the right reference.** It captures whatever theme,
  density and font size that account is set to. `theme-darker` is not
  `theme-dark` with a tweak, and diffing against the wrong one moves every
  surface at once.
- **Why** something is the way it is. The diff says the numbers differ. Which
  one is right is still a judgement.
