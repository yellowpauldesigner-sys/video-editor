# uberdesigner clips

**A video editor for designers: motion pieces with typography, numbers and simple infographics, cut together with
real footage. Edit by hand in the editor's window; ask Claude for changes, one scene at a time.**

One codebase, two ways to use it:

- **A Claude Code skill.** Claude makes the first cut and opens the editor on localhost beside the chat, the way
  [uberdesigner studio](https://github.com/bogdan239/uberdesigner-studio) opens its site editor. The clip lives in
  a folder (`clip.json` and `media/`), so Claude can see it and change it.
- **A plain website.** The same editor page without Claude: the clip is kept in the browser. This is what is
  deployed on Vercel.

## Install

In a Claude Code session, run:

```text
/plugin install uberdesigner-clips --marketplace yellowpauldesigner-sys/video-editor
```

That one line works on Claude Code 2.1.275 or later. On an earlier version, do it in two steps:

```text
/plugin marketplace add yellowpauldesigner-sys/video-editor
/plugin install uberdesigner-clips@uberdesigner
```

Updates arrive from this repository: `/plugin marketplace update uberdesigner` fetches the newest version.

To install it as a plain skill instead, clone the repository into your skills folder:

```bash
git clone https://github.com/yellowpauldesigner-sys/video-editor ~/.claude/skills/uberdesigner-clips
```

Then, in Claude Code:

```text
make a 15-second reel in uberdesigner clips: three claims, the number 87%, and this video between them
```

or

```text
open this video in uberdesigner clips
```

It needs Node.js 22 or newer and Google Chrome. Claude Code in the terminal is needed for changes by Claude inside
the editor. ffmpeg is not needed: the editor's page draws the frames and builds the video itself.

## What it does

- **Motion typography.** Text comes in by word, line or letter; a number counts from one value to another.
- **Infographics.** Bars that grow, dots and plates, built from simple shapes.
- **Video, pictures, sound.** Trim, speed, crop, music with fades.
- **A finished video becomes scenes.** The editor finds the cuts and lays the video out as scenes.
- **A timeline.** Drag edges to trim, drag scenes to reorder, `S` splits, Space plays, ⌘Z steps back.
- **Formats.** 16:9, 9:16, 1:1 and 4:5 from one clip; each format places a layer its own way.
- **Changes by Claude** (in the skill). A request carries one scene; the answer arrives as a card to keep, undo or
  refine.
- **Building.** MP4 (H.264) with sound, right in Chrome.

## How it is built

| Piece | Where | What it does |
|---|---|---|
| Editor | `app/` | A static page with no build step: layers, the frame on a canvas, the timeline, properties, and video export through WebCodecs |
| Clip format | `app/js/model.mjs` | What a `clip.json` may hold, its timing, its checks. One file for the page, the server and the scripts |
| Storage | `app/js/backend.js` | The only place the two modes differ: IndexedDB in the browser, or the skill's server |
| Server | `server/` | Node only. Serves the editor and the media, is the only writer of `clip.json`, keeps History, calls Claude Code |
| Scripts | `scripts/clips.mjs` | For Claude Code: `new`, `add`, `verify`, `split`, `still`, `render`, `serve` |
| Skill | `SKILL.md`, `reference/` | The steps Claude follows, and the format reference |
| Plugin | `.claude-plugin/` | The plugin manifest, and the marketplace entry that lets Claude Code install it from this repository |

`still`, `split` and `render` open the same engine in a headless Chrome (`app/headless.html`), so the frame
Claude looks at and the file it builds match what the person sees.

**A change by Claude.** The server runs `claude -p` with no tools, in an empty folder, and passes it a short
description of the format, the clip's facts, the list of files and one scene's JSON. The answer is checked in
full; if it fails, Claude gets the errors once; only then is the scene written and a point added to History.

## Vercel

`vercel.json` serves the `app/` folder as a static site, with no build.

## What leaves your computer

- Requests to Claude from the editor: the request text and the scene's JSON, through your own Claude Code.
- Google Fonts, when a clip names one.

There is no analytics. The skill's server listens on `127.0.0.1` only, and accepts changes only with a token that
only the editor's page is given.

## Tests

```bash
node --test tests/*.test.mjs
```

The clip format, and the server end to end with a stand-in for Claude (`tests/fake-claude.mjs`). They need no
browser.

## Not there yet

- Keyframes beyond one slow move per layer, masks, color correction.
- Charts beyond bars and dots.
- Waveforms, cutting to the beat, captions from speech.
- ProRes and HEVC video as input: Chrome doesn't play them.

The typeface, Instrument Sans, is under the SIL Open Font License (`app/fonts/OFL.txt`).
