// The app's one and only icon set.
//
// Every control in ScarmVoice draws from this file so nothing is hand-mixed:
// one 24x24 grid, one stroke weight, one cap/join style, one colour source
// (currentColor, so hover/active/disabled states actually tint the icon).
//
// Emoji are deliberately NOT in here. They are *content* — reactions, the
// picker, and whatever people type — and they render from a single emoji font
// (see --font-emoji in styles.css). Before this file the two were mixed: the
// message action bar alone had two full-colour emoji (which ignore
// currentColor) next to two hairline dingbats from a different font, at three
// different optical sizes.
(function () {
    'use strict';

    // Geometry contract for every glyph below:
    //   viewBox 0 0 24 24 · fill none · stroke currentColor
    //   stroke-width 1.8 · linecap round · linejoin round
    // A glyph that needs a solid mark (the record dot) opts in per element.
    const P = {
        // ---- app chrome ------------------------------------------------
        // 8-tooth cog, generated on a circle so it stays symmetric at 18px.
        // The old one was a hand-tweaked blob that turned to mush below 20px.
        gear: '<path d="M9.78 5.15L10.21 2.77L13.79 2.77L14.22 5.15L15.27 5.58L17.26 4.21L19.79 6.74' +
            'L18.42 8.73L18.85 9.78L21.23 10.21L21.23 13.79L18.85 14.22L18.42 15.27L19.79 17.26' +
            'L17.26 19.79L15.27 18.42L14.22 18.85L13.79 21.23L10.21 21.23L9.78 18.85L8.73 18.42' +
            'L6.74 19.79L4.21 17.26L5.58 15.27L5.15 14.22L2.77 13.79L2.77 10.21L5.15 9.78L5.58 8.73' +
            'L4.21 6.74L6.74 4.21L8.73 5.58Z"/><circle cx="12" cy="12" r="3"/>',

        // The same cog as a solid mark. The user-panel button is a
        // destination rather than an action, and the reference draws it filled
        // — an outline there reads as one more toggle in a row of toggles.
        // evenodd is what punches the centre hole out of the single path.
        'gear-solid': '<path fill="currentColor" stroke="none" fill-rule="evenodd" clip-rule="evenodd" ' +
            'd="M9.78 5.15L10.21 2.77L13.79 2.77L14.22 5.15L15.27 5.58L17.26 4.21L19.79 6.74' +
            'L18.42 8.73L18.85 9.78L21.23 10.21L21.23 13.79L18.85 14.22L18.42 15.27L19.79 17.26' +
            'L17.26 19.79L15.27 18.42L14.22 18.85L13.79 21.23L10.21 21.23L9.78 18.85L8.73 18.42' +
            'L6.74 19.79L4.21 17.26L5.58 15.27L5.15 14.22L2.77 13.79L2.77 10.21L5.15 9.78L5.58 8.73' +
            'L4.21 6.74L6.74 4.21L8.73 5.58Z' +
            'M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4Z"/>',

        // A person with a plus: "invite somebody", not "manage members".
        'user-add': '<circle cx="9.5" cy="8" r="3.8"/>' +
            '<path d="M2.8 20.2a6.9 6.9 0 0 1 13.4 0"/>' +
            '<path d="M19 6.6v6.4M15.8 9.8h6.4"/>',
        // A waveform with the noise struck out of it.
        noise: '<g stroke-linecap="round"><path d="M3.5 10v4"/><path d="M8 6.5v11"/>' +
            '<path d="M12.5 9v6"/><path d="M17 5.5v13"/><path d="M21 10v4"/></g>' +
            '<path class="ico-cut" d="M3.6 20.4L20.4 3.6"/><path d="M3.6 20.4L20.4 3.6"/>',

        // Connection strength, not a dot. A dot can only say connected or not;
        // four rising bars have somewhere to put "how well" when there is
        // something to report. Filled, because at 16px an outlined bar is
        // mostly outline.
        signal: '<g fill="currentColor" stroke="none">' +
            '<rect x="2.6" y="15.4" width="3.4" height="5.6" rx="1.2"/>' +
            '<rect x="8.1" y="11.6" width="3.4" height="9.4" rx="1.2"/>' +
            '<rect x="13.6" y="7.8" width="3.4" height="13.2" rx="1.2"/>' +
            '<rect x="19.1" y="4" width="3.4" height="17" rx="1.2"/></g>',
        // A soundboard is clips, not notes — a waveform says "these are sounds
        // you fire", where a quaver says "music is playing".
        waveform: '<g fill="currentColor" stroke="none">' +
            '<rect class="wv" x="2" y="9.5" width="2.6" height="5" rx="1.3"/>' +
            '<rect class="wv" x="6.7" y="6" width="2.6" height="12" rx="1.3"/>' +
            '<rect class="wv" x="11.4" y="3" width="2.6" height="18" rx="1.3"/>' +
            '<rect class="wv" x="16.1" y="6" width="2.6" height="12" rx="1.3"/>' +
            '<rect class="wv" x="20.8" y="9.5" width="2.6" height="5" rx="1.3"/></g>',

        // ---- microphone family -----------------------------------------
        // Plain mic = the mute toggle. Mic + solid dot = "record a voice
        // message", which is the one thing a bare mic could be confused with.
        // Shorter and wider than it was, so its ink lands in the same square
        // the headset's does. Drawn tall and narrow, the two sat side by side in
        // the user panel looking like different sizes — the headset measured 17%
        // larger — even though their boxes matched.
        mic: '<rect x="9.4" y="4" width="5.2" height="9.6" rx="2.6"/>' +
            '<path d="M4 11a8 8 0 0 0 16 0"/><path d="M12 19v1.8"/>',
        'mic-off': '<rect x="9.4" y="4" width="5.2" height="9.6" rx="2.6"/>' +
            '<path d="M4 11a8 8 0 0 0 16 0"/><path d="M12 19v1.8"/>' +
            // Drawn twice: a thick stroke in the surface colour first, then the
            // line itself. The gap that leaves is what stops the slash reading
            // as part of the mic at 22px — see .ico-cut in styles.css.
            '<path class="ico-cut" d="M3.6 3.2l16.8 17.6"/>' +
            '<path d="M3.6 3.2l16.8 17.6"/>',
        'mic-record': '<rect x="8.4" y="2.8" width="6" height="11" rx="3"/>' +
            '<path d="M5 11.2a6.4 6.4 0 0 0 12.8 0"/><path d="M11.4 17.6v3.6"/>' +
            '<circle class="rec-dot" cx="19.4" cy="4.9" r="2.7" fill="currentColor" stroke="none"/>',

        // Solid versions for the user panel. A destination-or-state control is
        // drawn filled there; the outline pair reads as two more toggles in a
        // row of toggles.
        'mic-solid': '<g fill="currentColor" stroke="none">' +
            '<rect x="9.4" y="4" width="5.2" height="9.6" rx="2.6"/>' +
            '<path d="M4 10.1a1.1 1.1 0 0 1 2.2 0 5.8 5.8 0 0 0 11.6 0 1.1 1.1 0 0 1 2.2 0' +
            'A8 8 0 0 1 13.1 18v2.8h2.3a1.1 1.1 0 0 1 0 2.2H8.6a1.1 1.1 0 0 1 0-2.2h2.3V18' +
            'A8 8 0 0 1 4 10.1Z"/></g>',
        'mic-solid-off': '<g fill="currentColor" stroke="none">' +
            '<rect x="9.4" y="4" width="5.2" height="9.6" rx="2.6"/>' +
            '<path d="M4 10.1a1.1 1.1 0 0 1 2.2 0 5.8 5.8 0 0 0 11.6 0 1.1 1.1 0 0 1 2.2 0' +
            'A8 8 0 0 1 13.1 18v2.8h2.3a1.1 1.1 0 0 1 0 2.2H8.6a1.1 1.1 0 0 1 0-2.2h2.3V18' +
            'A8 8 0 0 1 4 10.1Z"/></g>' +
            '<path class="ico-cut" fill="none" stroke="currentColor" d="M3.6 20.4L20.4 3.6"/>' +
            '<path fill="none" stroke="currentColor" d="M3.6 20.4L20.4 3.6"/>',
        'headset-solid': '<g fill="currentColor" stroke="none">' +
            '<path d="M12 2.6a9.4 9.4 0 0 0-9.4 9.4v4.7a3.3 3.3 0 0 0 3.3 3.3h1.4a1.3 1.3 0 0 0 1.3-1.3' +
            'v-5.6a1.3 1.3 0 0 0-1.3-1.3H4.9V12a7.1 7.1 0 0 1 14.2 0v-.2h-2.4a1.3 1.3 0 0 0-1.3 1.3' +
            'v5.6a1.3 1.3 0 0 0 1.3 1.3h1.4a3.3 3.3 0 0 0 3.3-3.3V12A9.4 9.4 0 0 0 12 2.6Z"/></g>',
        'headset-solid-off': '<g fill="currentColor" stroke="none">' +
            '<path d="M12 2.6a9.4 9.4 0 0 0-9.4 9.4v4.7a3.3 3.3 0 0 0 3.3 3.3h1.4a1.3 1.3 0 0 0 1.3-1.3' +
            'v-5.6a1.3 1.3 0 0 0-1.3-1.3H4.9V12a7.1 7.1 0 0 1 14.2 0v-.2h-2.4a1.3 1.3 0 0 0-1.3 1.3' +
            'v5.6a1.3 1.3 0 0 0 1.3 1.3h1.4a3.3 3.3 0 0 0 3.3-3.3V12A9.4 9.4 0 0 0 12 2.6Z"/></g>' +
            '<path class="ico-cut" fill="none" stroke="currentColor" d="M3.6 20.4L20.4 3.6"/>' +
            '<path fill="none" stroke="currentColor" d="M3.6 20.4L20.4 3.6"/>',

        headset: '<path d="M4 14v-2.4a8 8 0 0 1 16 0V14"/>' +
            '<path d="M4 13.4a1.9 1.9 0 0 1 1.9-1.9h1.3v6.6H5.9A1.9 1.9 0 0 1 4 16.2z"/>' +
            '<path d="M20 13.4a1.9 1.9 0 0 0-1.9-1.9h-1.3v6.6h1.3a1.9 1.9 0 0 0 1.9-1.9z"/>',
        'headset-off': '<path d="M4 14v-2.4a8 8 0 0 1 16 0V14"/>' +
            '<path d="M4 13.4a1.9 1.9 0 0 1 1.9-1.9h1.3v6.6H5.9A1.9 1.9 0 0 1 4 16.2z"/>' +
            '<path d="M20 13.4a1.9 1.9 0 0 0-1.9-1.9h-1.3v6.6h1.3a1.9 1.9 0 0 0 1.9-1.9z"/>' +
            '<path class="ico-cut" d="M3.6 3.2l16.8 17.6"/>' +
            '<path d="M3.6 3.2l16.8 17.6"/>',

        // Handset tipped over, the universal "hang up".
        // The handset turned down, on its own. Slashing it as well is what made
        // it read as an eye with a line through it rather than as a phone —
        // this shape IS the hang-up, and it is wide and flat the way the
        // reference draws it.
        'phone-hangup': '<path d="M3.4 9.2a13.6 13.6 0 0 1 17.2 0v3a1.6 1.6 0 0 1-1.6 1.6h-2a1.6 1.6 0 0 1-1.6-1.4' +
            'l-.2-1.5a10.6 10.6 0 0 0-6 0l-.2 1.5a1.6 1.6 0 0 1-1.6 1.4H5a1.6 1.6 0 0 1-1.6-1.6z"/>',
        // The slashed variant stays for "remove somebody FROM voice", where the
        // mark has to say denial rather than hang up.
        'phone-off': '<path d="M3.4 9.2a13.6 13.6 0 0 1 17.2 0v3a1.6 1.6 0 0 1-1.6 1.6h-2a1.6 1.6 0 0 1-1.6-1.4' +
            'l-.2-1.5a10.6 10.6 0 0 0-6 0l-.2 1.5a1.6 1.6 0 0 1-1.6 1.4H5a1.6 1.6 0 0 1-1.6-1.6z"/>' +
            '<path class="ico-cut" d="M3.6 20.4L20.4 3.6"/>' +
            '<path d="M3.6 20.4L20.4 3.6"/>',

        speaker: '<path d="M11 4.6L6.2 8.7H3.4v6.6h2.8L11 19.4z"/>' +
            '<path d="M15.2 9a4.4 4.4 0 0 1 0 6"/><path d="M18 6.2a8.4 8.4 0 0 1 0 11.6"/>',
        volume: '<path d="M11 4.6L6.2 8.7H3.4v6.6h2.8L11 19.4z"/><path d="M15.2 9a4.4 4.4 0 0 1 0 6"/>',
        'volume-off': '<path d="M11 4.6L6.2 8.7H3.4v6.6h2.8L11 19.4z"/>' +
            '<path d="M16.4 9.6l5 4.8"/><path d="M21.4 9.6l-5 4.8"/>',

        camera: '<path class="cam-lens" d="M22.4 7.6l-6.4 4.4 6.4 4.4z"/>' +
            '<rect class="cam-body" x="1.6" y="5.2" width="14.4" height="13.6" rx="2.4"/>' +
            '<circle class="cam-rec" cx="19.8" cy="4.6" r="2.3" fill="currentColor" stroke="none"/>',
        // The arrow rides out of the frame on hover, which is what the button
        // does: it sends this screen outward.
        screen: '<g class="mon-frame"><rect x="2.2" y="4" width="19.6" height="13" rx="2.2"/>' +
            '<path d="M8 21h8M12 17v4"/></g>' +
            '<g class="mon-arrow"><path d="M12 13.6V8M9.4 10.6L12 8l2.6 2.6"/></g>',
        // The same monitor WITHOUT the outbound arrow. `screen` means "send this
        // screen outward" — it is the share button — and beside the words
        // "Entire Screen" in the picker's category row that arrow reads as a
        // second verb where a noun belongs.
        monitor: '<rect x="2.2" y="4" width="19.6" height="13" rx="2.2"/>' +
            '<path d="M8 21h8M12 17v4"/>',
        upload: '<path d="M12 16.4V4.2"/><path d="M6.4 9.8L12 4.2l5.6 5.6"/><path d="M3.6 19.8h16.8"/>',

        // ---- navigation + generic actions -------------------------------
        plus: '<path d="M12 5v14M5 12h14"/>',
        'plus-circle': '<circle cx="12" cy="12" r="8.6"/><path d="M12 8.2v7.6M8.2 12h7.6"/>',
        chevron: '<path d="M9.4 5.6L15.8 12l-6.4 6.4"/>',
        // The same mark drawn pointing down, rather than the right-pointing one
        // turned with a CSS rotate. A rotated glyph keeps its UNROTATED box, so
        // the two disagree about where its centre is — which is how the user
        // panel's carets ended up sitting seven pixels right of their buttons,
        // beside the icon that follows them instead of the one they belong to.
        'chevron-down': '<path d="M5.6 9.4L12 15.8l6.4-6.4"/>',
        search: '<circle cx="11" cy="11" r="6.8"/><path d="M20.8 20.8l-4.4-4.4"/>',
        x: '<path d="M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
        check: '<path d="M4.6 12.6l4.8 4.8L19.4 7.2"/>',
        'arrow-down': '<path d="M12 4.6v14.8"/><path d="M5.6 13l6.4 6.4L18.4 13"/>',
        'arrow-up': '<path d="M12 19.4V4.6"/><path d="M5.6 11L12 4.6 18.4 11"/>',
        external: '<path d="M14.2 4.4h5.4v5.4"/><path d="M19.6 4.4L11 13"/>' +
            '<path d="M18.2 14v4.6a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8V7.8A1.8 1.8 0 0 1 5.6 6h4.6"/>',

        pin: '<path d="M9.4 3.6h5.2l-.8 5.4 3.6 3.4v1.8H6.6v-1.8l3.6-3.4z"/><path d="M12 14.2v6.2"/>',
        pencil: '<path d="M4 20h4.2L20 8.2 15.8 4 4 15.8z"/><path d="M14.6 5.2l4.2 4.2"/>',
        trash: '<path d="M3.8 6.6h16.4"/><path d="M9.2 6.6V4.4h5.6v2.2"/>' +
            '<path d="M6 6.6l1 13.2a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9l1-13.2"/>',
        users: '<circle cx="9" cy="7.8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/>' +
            '<circle cx="17.6" cy="9" r="2.6"/><path d="M16 20a5.8 5.8 0 0 1 5.4-4.6"/>',
        // A speech bubble, for "Message" — a reply arrow means "answer this", and
        // the button on a profile means "start talking to this person".
        chat: '<path d="M20.4 15.2a2 2 0 0 1-2 2H8.2L4 21V6.2a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2z"/>',
        // The overflow. Filled, like the crown: three 1.6px rings at this size read
        // as smudges where three discs read as dots.
        more: '<circle cx="5.5" cy="12" r="1.9" fill="currentColor" stroke="none"/>' +
            '<circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/>' +
            '<circle cx="18.5" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
        // An open door with an arrow leaving through it — the reference's Log Out.
        logout: '<path d="M9.4 20.2H5.2a1.4 1.4 0 0 1-1.4-1.4V5.2a1.4 1.4 0 0 1 1.4-1.4h4.2"/>' +
            '<path d="M15.6 16.4l4.4-4.4-4.4-4.4"/><path d="M20 12H9.4"/>',
        // FILLED, unlike everything else here: it is drawn at 12px beside a name,
        // and a stroked crown at that size is four hairlines and a smudge. The
        // fill comes from the rule, so it still takes its colour from the theme.
        crown: '<path fill="currentColor" stroke="none" d="M3 18.4h18l1.6-10.2-5.4 3.6L12 4.4' +
            'l-5.2 7.4-5.4-3.6zM3 20h18v1.6H3z"/>',
        // Paper plane, drawn rather than filled so it matches everything else.
        send: '<path d="M21.4 3.4L10.6 14.2"/><path d="M21.4 3.4l-6.8 18-3.9-8.1-8.1-3.9z"/>',
        paperclip: '<path d="M20.6 11.7l-8.8 8.8a4.9 4.9 0 0 1-6.9-6.9l9-9a3.4 3.4 0 0 1 4.8 4.8l-8.9 8.9' +
            'a1.9 1.9 0 0 1-2.7-2.7l8.2-8.2"/>',
        download: '<path d="M12 3.6v11"/><path d="M7.4 10l4.6 4.6L16.6 10"/><path d="M4 19.4h16"/>',
        save: '<path d="M4.8 3.8h11.4L20.2 7.8v12a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V4.6a.8.8 0 0 1 .8-.8z"/>' +
            '<path d="M8 3.8v5.4h7V3.8"/><rect x="7.4" y="13.4" width="9.2" height="7.2" rx="1"/>',
        copy: '<rect x="8.4" y="8.4" width="12" height="12" rx="2"/>' +
            '<path d="M15.6 5.4v-.8a1.2 1.2 0 0 0-1.2-1.2H4.8a1.2 1.2 0 0 0-1.2 1.2v9.6a1.2 1.2 0 0 0 1.2 1.2h.8"/>',
        reply: '<path d="M9.4 6.2L3.8 11.8l5.6 5.6"/><path d="M3.8 11.8h9.6a6.8 6.8 0 0 1 6.8 6.8v1.2"/>',
        thread: '<path d="M20.4 13.6a2 2 0 0 1-2 2H8.6L4.4 19.8V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>' +
            '<path d="M8.4 8.6h8M8.4 11.8h5"/>',
        // The header's Threads button. Three right-leaning strokes — the
        // reference's glyph, deliberately NOT the speech bubble `thread` uses on a
        // message row: one means "this message has a thread", the other means
        // "every thread in this channel".
        //
        // Heavier and filling more of the box than it did: at 18px it drew a 15x10
        // ink mark against the reference's 22x22, which read as a scratch beside the
        // title rather than as an icon. See `threads-empty` for the illustration.
        threads: '<g stroke-width="2.6"><path d="M3.4 19L9.6 5"/><path d="M9.9 19L16.1 5"/>' +
            '<path d="M16.4 19L22.6 5"/></g>',
        smile: '<circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/>' +
            '<path d="M9.4 9.4h.01M14.6 9.4h.01" stroke-width="2.4"/>',
        at: '<circle cx="12" cy="12" r="3.6"/>' +
            '<path d="M15.6 8.4v4.8a2.8 2.8 0 0 0 5.6 0V12a9.2 9.2 0 1 0-3.6 7.3"/>',
        ban: '<circle cx="12" cy="12" r="8.6"/><path d="M5.9 5.9l12.2 12.2"/>',
        // A struck-through person, for banning an ACCOUNT — distinct from `ban`
        // (the plain circle-slash), which already means "block this person for
        // me". The two actions sit next to each other in the popover, so they
        // must not share a glyph.
        'user-ban': '<circle cx="10" cy="8" r="3.8"/>' +
            '<path d="M3.4 20.2a6.8 6.8 0 0 1 11.1-5.3"/>' +
            '<circle cx="17.4" cy="17.4" r="4.2"/><path d="M14.4 14.4l6 6"/>',
        bell: '<path d="M18 8.8a6 6 0 0 0-12 0c0 6-2.4 7.6-2.4 7.6h16.8S18 14.8 18 8.8"/>' +
            '<path d="M13.7 20.2a2 2 0 0 1-3.4 0"/>',
        'bell-off': '<path d="M18 8.8a6 6 0 0 0-12 0c0 6-2.4 7.6-2.4 7.6h16.8S18 14.8 18 8.8"/>' +
            '<path d="M13.7 20.2a2 2 0 0 1-3.4 0"/><path d="M3.6 3.4l16.8 17.2"/>',
        moon: '<path d="M20.4 13.6A8.6 8.6 0 0 1 10.4 3.6a8.6 8.6 0 1 0 10 10z"/>',
        // A bare dash — remove-this-colour in the theme picker's hex row. At
        // the set's 1.8 stroke a lone horizontal line averages out to almost
        // nothing against the field; it opts into a heavier weight the way the
        // record dot opts into a fill.
        minus: '<path d="M5.6 12h12.8" stroke-width="2.8"/>',
        // Two curved arrows chasing each other — the sync-with-Windows theme
        // tile's glyph.
        sync: '<path d="M4.6 10a7.6 7.6 0 0 1 12.9-3.4L19.4 8.5M19.4 4.5v4h-4"/>' +
            '<path d="M19.4 14a7.6 7.6 0 0 1-12.9 3.4L4.6 15.5M4.6 19.5v-4h4"/>',
        // Painter's palette — the customize-your-theme title glyph.
        palette: '<path d="M12 3a9 9 0 1 0 0 18h1.4a2.1 2.1 0 0 0 1.5-3.6 2.1 2.1 0 0 1 1.5-3.6H19a2 2 0 0 0 2-2A9 9 0 0 0 12 3z"/>' +
            '<circle cx="7.8" cy="10.4" r=".9"/><circle cx="12" cy="7.6" r=".9"/><circle cx="16.2" cy="10.4" r=".9"/>',
        // Pipette, tip to the lower-left — the custom theme picker's
        // pick-a-colour-from-the-screen control.
        eyedropper: '<path d="M13.2 6.8l4 4M15.2 4.8l1.6-1.6a2.1 2.1 0 0 1 3 3l-1.6 1.6a1.4 1.4 0 0 1-2 0l-1-1a1.4 1.4 0 0 1 0-2z"/>' +
            '<path d="M13.7 8.3l-7.5 7.5c-.5.5-.8 1.1-.9 1.8l-.3 2c-.1.7.5 1.3 1.2 1.2l2-.3c.7-.1 1.3-.4 1.8-.9l7.5-7.5"/>',
        sun: '<circle cx="12" cy="12" r="4.2"/>' +
            '<path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6L6 18M18 6l1.6-1.6"/>',
        sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/>' +
            '<circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',

        // ---- content kinds (filters, attachments, staged files) ----------
        link: '<path d="M10.2 13.8a4.2 4.2 0 0 0 6.3.4l2.5-2.5a4.2 4.2 0 0 0-5.9-5.9l-1.4 1.4"/>' +
            '<path d="M13.8 10.2a4.2 4.2 0 0 0-6.3-.4L5 12.3a4.2 4.2 0 0 0 5.9 5.9l1.4-1.4"/>',
        image: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.2"/>' +
            '<circle cx="8.6" cy="9.6" r="1.8"/><path d="M20.8 15.6l-4.6-4.4-8.8 8.4"/>',
        video: '<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.2"/>' +
            '<path d="M2.6 9.4h18.8M8 4.6v4.8M16 4.6v4.8M8 19.4v-4.4M16 19.4v-4.4"/>',
        music: '<path d="M9.4 18V5.4l10-1.8V16"/><circle cx="6.6" cy="18" r="2.8"/><circle cx="16.6" cy="16" r="2.8"/>',
        file: '<path d="M13.6 3.4H6.8a1.8 1.8 0 0 0-1.8 1.8v13.6a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V8.6z"/>' +
            '<path d="M13.6 3.4v5.2h5.4"/>',
        doc: '<path d="M13.6 3.4H6.8a1.8 1.8 0 0 0-1.8 1.8v13.6a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V8.6z"/>' +
            '<path d="M13.6 3.4v5.2h5.4"/><path d="M8.4 13h7.2M8.4 16.4h5"/>',
        sheet: '<rect x="4" y="4" width="16" height="16" rx="1.8"/><path d="M4 9.6h16M4 15h16M9.6 4v16"/>',
        slides: '<rect x="3.4" y="4.6" width="17.2" height="12" rx="1.8"/><path d="M12 16.6v4M8.4 20.6h7.2"/>',
        archive: '<rect x="3.2" y="4.2" width="17.6" height="4.6" rx="1.2"/>' +
            '<path d="M5 8.8v9.4a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V8.8"/><path d="M10.2 12.6h3.6"/>',
        disc: '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.6"/>',
        app: '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.2"/><path d="M3.4 8.6h17.2"/>' +
            '<path d="M6.6 6h.01M9.4 6h.01" stroke-width="2.2"/>',
        play: '<path d="M7.6 4.8l12 7.2-12 7.2z"/>',
        warning: '<path d="M12 3.6l9.4 16.2H2.6z"/><path d="M12 9.8v4.4M12 17.2h.01" stroke-width="2.2"/>',

        // ---- composer context menu --------------------------------------
        scissors: '<circle cx="6.4" cy="6.4" r="2.8"/><circle cx="6.4" cy="17.6" r="2.8"/>' +
            '<path d="M8.8 8.4L20.4 19.6M20.4 4.4L8.8 15.6"/>',
        clipboard: '<rect x="5" y="5" width="14" height="16" rx="1.8"/>' +
            '<path d="M9 5V3.8a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 3.8V5z"/>',
        list: '<path d="M4 6.4h16M4 12h16M4 17.6h10"/>',

        // ---- the composer's formatting bar ------------------------------
        // Every one of these is a MARK, not a letter drawn as a path: the
        // toolbar sets its own type in the app's font for B/I/U/S, the way the
        // reference does, so these are only the ones that have no letter.
        //
        // The Format toggle itself: an "A" with a pen across its foot.
        format: '<path d="M3.2 18.4L8 6.2l4.8 12.2M5.1 14.4h5.8"/>' +
            '<path d="M14.4 18.6l1.1-3 5.1-5.1a1.3 1.3 0 0 1 1.9 1.9l-5.1 5.1z"/>',
        'list-bullet': '<path d="M9 6.4h11M9 12h11M9 17.6h11"/>' +
            '<circle cx="4.6" cy="6.4" r="1.5" fill="currentColor" stroke="none"/>' +
            '<circle cx="4.6" cy="12" r="1.5" fill="currentColor" stroke="none"/>' +
            '<circle cx="4.6" cy="17.6" r="1.5" fill="currentColor" stroke="none"/>',
        'list-number': '<path d="M9.6 6.4h10.4M9.6 12h10.4M9.6 17.6h10.4"/>' +
            '<path d="M3.4 4.6l1.4-.7v4M3.2 10.4a1.4 1.4 0 1 1 2.4 1L3.2 14h2.6M3.4 15.9h2.2l-1.3 1.5' +
            'a1.3 1.3 0 1 1-.9 2.2"/>',
        quote: '<path d="M4.4 16.6c0-4.6 1.4-7.4 4.6-8.8l.8 1.7c-1.9 1-2.8 2.3-2.9 4h2.5v5.4H4.4z"/>' +
            '<path d="M13.6 16.6c0-4.6 1.4-7.4 4.6-8.8l.8 1.7c-1.9 1-2.8 2.3-2.9 4h2.5v5.4h-5z"/>',
        // A fenced block, not the inline span: brackets around stacked rules.
        'code-block': '<rect x="2.8" y="4.4" width="18.4" height="15.2" rx="2"/>' +
            '<path d="M8.6 9.6L6.4 12l2.2 2.4M15.4 9.6L17.6 12l-2.2 2.4M12.9 9l-1.8 6"/>',
        code: '<path d="M8.4 7.6L3.6 12l4.8 4.4M15.6 7.6L20.4 12l-4.8 4.4M13.6 5.4l-3.2 13.2"/>',
        // The heading control, which is this app's honest answer to a font-size
        // menu: Markdown has three heading levels and no type scale.
        heading: '<path d="M4.4 5.2v13.6M12.4 5.2v13.6M4.4 12h8"/><path d="M16.4 18.8V9.6l3.2-1.6v10.8"/>',
        spoiler: '<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z"/>' +
            '<circle cx="12" cy="12" r="3"/><path d="M4 20L20 4"/>',
        // The reference's highlighter pen. It writes inline code here, which is
        // the one way Markdown puts text on a coloured plate.
        highlight: '<path d="M8.6 15.4l-3 .8.8-3 8.2-8.2a1.7 1.7 0 0 1 2.4 0l1.8 1.8a1.7 1.7 0 0 1 0 2.4z"/>' +
            '<path d="M13.4 6.6l4 4"/><path d="M4 20.4h16"/>',
        // Two A's, large and small: the size control.
        'text-size': '<path d="M2.6 17.4L6.6 6.6l4 10.8M3.9 14.2h5.4"/>' +
            '<path d="M13.4 17.4l3.2-8 3.2 8M14.4 14.9h4.4"/>',
        trash: '<path d="M4.4 6.6h15.2M9.6 6.6V4.4h4.8v2.2"/>' +
            '<path d="M6.6 6.6l.8 12.2a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12.2"/>' +
            '<path d="M10.2 10.2v6.4M13.8 10.2v6.4"/>',
        // Settings nav. `accessibility` is the standing figure in a ring the
        // reference uses; `system` is a desktop tower.
        accessibility: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor" stroke="none"/>' +
            '<path d="M7.6 10.4h8.8"/><path d="M10.2 10.8L9.4 17M13.8 10.8l.8 6.2"/>',
        system: '<rect x="3.4" y="3.4" width="10.2" height="17.2" rx="1.8"/>' +
            '<path d="M6.4 7.2h4.2M6.4 10.2h4.2"/><circle cx="8.5" cy="16.4" r="1.6"/>' +
            '<path d="M16.6 7.4h4M16.6 12h4M16.6 16.6h4"/>',
        // A curved arrow back over its own tail, and its mirror. Mirrored by hand
        // rather than with a transform, because the icon set is raw path data that
        // build() drops straight into one <svg> shape.
        // Mark As Read, on the new-messages bar: a speech bubble with a tick in
        // it, which is what the reference puts beside that label.
        'mark-read': '<path d="M20.4 13.6a2 2 0 0 1-2 2H8.6L4.4 19.8V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>' +
            '<path d="M8.8 9.8l2.4 2.4 4.2-4.2"/>',
        undo: '<path d="M4 9.6h10.4a5.4 5.4 0 0 1 0 10.8H7.2"/><path d="M8 5.2L3.6 9.6 8 14"/>',
        redo: '<path d="M20 9.6H9.6a5.4 5.4 0 0 0 0 10.8h7.2"/><path d="M16 5.2l4.4 4.4L16 14"/>',

        // ---- illustrations ------------------------------------------------
        // Not glyphs: their own box, filled rather than stroked, and their own
        // colours. See entry() for why that is a different shape of value.
        //
        // The threads empty state. The reference composes one rather than scaling
        // its header icon up — a disc holding the mark, a gold sparkle at the lower
        // left and a small blue cluster at the upper right — and that composition is
        // most of why its empty state reads as designed rather than as missing
        // content. Colours are literal because the whole point is that they differ
        // from each other; only the disc and the mark track the theme.
        'threads-empty': {
            box: '0 0 104 80',
            inner:
                // The disc, a step lighter than the panel it sits on.
                '<circle cx="53" cy="39" r="29" fill="#2e2e35"/>' +
                // The mark inside it: three right-leaning bars, thicker than the
                // header glyph because at this size a hairline reads as a scratch.
                '<g stroke="#b7b8c0" stroke-width="4.6" stroke-linecap="round" fill="none">' +
                '<path d="M41 51L48 27"/><path d="M50 51L57 27"/><path d="M59 51L66 27"/>' +
                '</g>' +
                // A four-pointed sparkle, lower left. Concave sides, so it reads as
                // a sparkle rather than as a diamond.
                '<path fill="#e8a723" d="M13 48' +
                'Q15.4 57.6 22 60Q15.4 62.4 13 72Q10.6 62.4 4 60Q10.6 57.6 13 48Z"/>' +
                // …and a cluster of small ones, upper right.
                '<path fill="#5d67f6" d="M88 8Q89.4 13.6 94 15Q89.4 16.4 88 22Q86.6 16.4 82 15Q86.6 13.6 88 8Z"/>' +
                '<path fill="#7b84ff" d="M97 22Q97.9 25.4 100.8 26.3Q97.9 27.2 97 30.6Q96.1 27.2 93.2 26.3Q96.1 25.4 97 22Z"/>' +
                '<circle cx="80" cy="28" r="2.2" fill="#5d67f6"/>'
        }
    };

    const NS = 'http://www.w3.org/2000/svg';

    // Every glyph shares one 24x24 box and one stroke contract, which is what makes
    // the set look like a set. An ILLUSTRATION is not a glyph, though: it is wider
    // than it is tall, it is filled rather than stroked, and it carries its own
    // colours. So an entry may be `{ box, inner }` instead of a string, and only
    // those get a different viewBox — nothing else in the set changes.
    function entry(name) {
        const v = P[name];
        if (!v) return null;
        return typeof v === 'string' ? { box: '0 0 24 24', inner: v } : v;
    }

    function build(name, className) {
        const e = entry(name);
        if (!e) { console.warn('[icons] unknown icon: ' + name); return null; }
        const wrap = document.createElementNS(NS, 'svg');
        wrap.setAttribute('viewBox', e.box);
        wrap.setAttribute('aria-hidden', 'true');
        wrap.setAttribute('class', className || 'ico');
        // Parsed as SVG, not HTML, so <circle>/<rect> land in the right namespace.
        const doc = new DOMParser().parseFromString(
            '<svg xmlns="' + NS + '">' + e.inner + '</svg>', 'image/svg+xml');
        Array.from(doc.documentElement.childNodes).forEach((n) => wrap.appendChild(n));
        return wrap;
    }

    // Markup form, for the places that still assemble a row with innerHTML.
    function markup(name, className) {
        const e = entry(name);
        if (!e) { console.warn('[icons] unknown icon: ' + name); return ''; }
        return '<svg viewBox="' + e.box + '" aria-hidden="true" class="' +
            (className || 'ico') + '">' + e.inner + '</svg>';
    }

    // Swap every <span data-icon="…"> placeholder for its glyph, carrying the
    // placeholder's own attributes across (class, hidden, title, …).
    function hydrate(root) {
        (root || document).querySelectorAll('[data-icon]').forEach((el) => {
            const svg = build(el.dataset.icon, el.getAttribute('class') || 'ico');
            if (!svg) return;
            Array.from(el.attributes).forEach((a) => {
                if (a.name === 'data-icon' || a.name === 'class') return;
                svg.setAttribute(a.name, a.value);
            });
            el.replaceWith(svg);
        });
    }

    // Every glyph is aria-hidden (correctly — it is decoration, and its shape
    // means nothing to a screen reader). The consequence is that an icon-only
    // button has NO accessible name at all: it is announced as just "button".
    //
    // All of them already carry a `title` for the tooltip, which is the name a
    // sighted user gets, so mirror it into aria-label. Doing it here rather than
    // by hand in the markup means a new icon button is labelled by default and
    // cannot be forgotten.
    function labelIconButtons(root) {
        (root || document).querySelectorAll('button[title]:not([aria-label])').forEach((b) => {
            // Only when there is no text of its own to announce.
            if (b.textContent.trim()) return;
            b.setAttribute('aria-label', b.getAttribute('title'));
        });
    }

    window.ScarmIcons = { markup, build, hydrate, labelIconButtons, has: (n) => !!P[n] };
    hydrate(document);
    labelIconButtons(document);
})();
