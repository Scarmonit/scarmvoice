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
- relative luminance, which is what every "too bright" note has actually been
- box model, and the **ink** extent of any glyph inside it — what the eye
  measures is never the box the icon is drawn in
- font size, weight, tracking, line height, case
- tooltip text
- whether a `:hover` / `:active` rule exists, and what it changes
- glyph geometry: viewBox, fill, path data

## Running it

```
npm run spec:app            # our side, via dev/harness.html
npm run spec:app -- voice   # a scene: voice, members, settings
npm run spec:diff dev/spec/out/discord.json dev/spec/out/app.json
```

The reference side needs the browser that is signed in to it, so it is two
steps rather than one:

1. `npm run spec:pack` writes `out/_payload.js` — the probe and the targets as
   one blob.
2. Paste that into the console on a Discord **channel** view (not Friends) and
   save what it returns to `out/discord.json`.

Discord's CSP blocks a remote `<script>` and a `fetch` to localhost, so the
payload has to arrive as literal source. That is the one manual step left.

## Adding a component

Two lines in `targets.js`: a finder for each side.

Ours is a selector, because we own the markup. Discord's has to be a predicate
against geometry, text or role — its class names are hashed and change on every
deploy, so `.chatContent_f75fb0` is worthless a week later while "the painted
column wider than 40% of the window" keeps working.

## What it will not tell you

- **Whether a difference is worth copying.** Blurple sliders, DMs in their own
  view, an end-to-end-encryption badge we cannot honestly display — those are
  decisions, and the diff has no opinion.
- **Anything off screen.** A menu has to be opened before it can be measured;
  that is what the scenes in the harness are for.
- **Why** something is the way it is. The diff says the numbers differ. Which
  one is right is still a judgement.
