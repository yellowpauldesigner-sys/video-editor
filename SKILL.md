---
name: uberdesigner-clips
description: Make and edit short videos in uberdesigner clips, a video editor that opens on localhost beside the chat. A clip is scenes and layers on a timeline (motion typography, counters and simple infographics, video, pictures, sound); the person edits by hand in the editor and asks Claude to change one scene at a time; the video is built in the browser in several formats (16:9, 9:16, 1:1, 4:5). Use when someone wants a motion video, a reel, a case film or an explainer made from text, numbers and footage; wants a finished video opened for editing, cut into scenes, captioned, re-timed or re-formatted; asks to set up or open uberdesigner clips (the clip editor); or asks to change, look at or render a clip that has a clip.json.
---

# uberdesigner clips

A clip is one file, `clip.json` (scenes, each with layers: text, shape, video, image, or a recorded site), next to
a `media/` folder. **uberdesigner clips** is an editor on localhost over that file: layers on the left, the frame
in the middle with a timeline under it, the picked thing's values on the right, and a chat bar under the frame.
The person cuts, moves and retimes by hand at no token cost, and asks Claude for a change to one scene from that
chat bar: the request carries only that scene's JSON, so it is a call of one or two thousand tokens, and its
result arrives as a card to keep, undo or refine. The editor's page draws every frame and builds the MP4 itself.

Your part is the first cut. After that the person works in the editor and comes back to you for bigger things.

The editor's interface and everything the scripts print are in English. Talk to the person in the language they
write in, name the editor's buttons as they are on screen, and write the clip's own words (its titles, captions
and labels) in the language the video is for.

Scripts are in `scripts/` next to this file; run them with Node from anywhere. `<project>` is the clip's folder.
The format is in `reference/clip-format.md`, with a complete example in `reference/example.clip.json`. Read the
format reference once before you write a clip.

## 0. Get the computer ready: you explain, they do each step

The studio needs two programs, and wants a third:
1. **Node.js 22 or newer**: runs the studio's small local server.
2. **Google Chrome** (or Edge): the editor opens in it, and it is what builds the video.
3. **Claude Code in the terminal, logged in** (wanted, not needed): the editor's chat bar runs it, on the person's
   own Claude account. Without it everything else works; changes by Claude inside the editor wait.

**Two rules.** Say what will happen and why before every step. And **they do each step themselves**: you never
install anything or log in for them. The only command in your message is the one for their step, in its own `bash`
block. Your own checks stay out of your words.

1. **Check**: `sh scripts/setup-check.sh` (on Windows: `node scripts/clips.mjs check`). `READY` → say nothing about
   it and go on, using the Node it names. Otherwise it prints `STEPS`, `NEXT`, and `PERSON RUNS <command>` or
   `PERSON OPENS <link>`: give exactly that. A line `OPTIONAL` means the step can be put off: say so in a sentence.
2. **Say what's coming once**, then give the first step; number them when there are several. Keep each short: a
   bold line that names the thing in plain words, one sentence on why, how to start the command (in the Claude
   desktop app: "Press ▶ on the command"; in a terminal session: "Type `!` and then the command"), the command.
3. **Wait without asking**: run `sh scripts/setup-check.sh --wait 600` in the background right after your message;
   it returns when the step is done. Carry on until `READY`.

## 1. Understand the video

Before any file: what is it for and where will it be watched? Take what the person already said; ask only for
what is missing and changes the work, at most two questions:
- **Where it goes**: Reels, Shorts, Stories → 9:16, 8–25 s; a feed post → 4:5 or 1:1; a site, a deck or YouTube →
  16:9. Several is normal: one clip is made in all of them.
- **What it's made from**: the words and numbers it should say (or a text to draw them from), and any footage,
  pictures or music to put between them.

Don't ask about fonts, colors or transitions. Take them from the brand or the footage, and let the person change
them in the editor.

There are two ways in. Most requests are the first.

### A. A motion video from words, numbers and footage

The usual clip: statements in big type, a number that counts up, a small chart, and real video between them.

```
node scripts/clips.mjs new <project> --name "…" --format 9:16
node scripts/clips.mjs add <project> <file> [<file>…]
```

Put the clip in its own folder (suggest one: `~/Desktop/<name>-clip`). `add` copies files into `media/` and prints
what it could learn about each. Without ffprobe on the computer it can't say a video's length: the editor finds it
out when it opens the clip. If you need the length to write the clip, `split` (below) prints it.

Then write `clip.json` in one go (step 2).

### B. A finished video, opened for editing

The person has a video (generated, recorded, exported) and wants to edit it: reorder, trim, caption, re-format.

```
node scripts/clips.mjs new <project> --name "…"
node scripts/clips.mjs add <project> <video file>
node scripts/clips.mjs split <project> media/<video file>
```

`split` finds the shots and prints where each starts and how long it lasts. Write one scene per shot: a `video`
layer with `trim.in` at the shot's start, in a scene as long as the shot, `volume: 1` if the video has sound that
matters. Name each scene by what is in it only if you looked (take a `still`); otherwise "Scene 1", "Scene 2".
If `split` finds no cuts, make it one scene and tell the person that **S** cuts at the playhead and that the media
library has **✂ Split into scenes** for any video added later.

## 2. Write clip.json

This is the step that takes judgment. Write the whole file at once.

**The shape of a motion clip.** One idea per scene, 1.5–4 s each. A statement → a number → a piece of footage → a
statement → the end card, or whatever order the story wants. Each scene has a background color and 1–4 layers.

**Kinetic type.** A `text` layer with `animate: { "by": "word", "type": "up" }` comes in word by word. Use `word`
for statements, `line` for two-line captions, `letter` only for one or two words. Two to six words on screen at a
time, big (`size` 90–180). After the last word has come in, leave about 0.35 s per word to read it. Use `animate`
instead of `enter`, not with it.

**Numbers.** A `text` with `"text": "{n}%"` and `"count": { "from": 0, "to": 87, "duration": 1.4 }` counts up.
The number is the hero of its scene (`size` 220–320); its label is a second, small text beside or under it.

**Infographics.** Built from `shape` layers placed by hand: a bar is a rect with `enter: { "type": "grow-y" }`
(or `grow-x` for a horizontal one), a dot is an `ellipse`, a rule is a thin rect. Put bars on a common baseline,
start them 0.08–0.15 s apart, and label each value with a text. Three to five bars read; ten don't.

**Footage.** A `video` layer, full frame, or inset as a card (`box` 80–90 %, `radius` 30–40) when it sits between
graphic scenes. `trim.in` picks the moment; keep each piece 2–5 s.

**Rules that keep it from looking generated.**
- One typeface, two or three sizes, two or three colors for the whole clip. Background and ink come from the
  brand; if there is none, near-black with white, plus one accent.
- Motion eases out (`expoOut` for type). Between scenes: `cut`, or `fade` / `slide-up` 0.4–0.5 s. Pick one and
  keep it for the whole clip.
- Text stays inside the middle 84 % of the frame, and clear of the bottom 12 % in 9:16.
- Every still picture gets a slow `move` (scale 1 → 1.1).

**Formats.** Write the clip for its main format, then give layers a `formats` override where another format needs
it: type is usually smaller and stacked in 9:16, charts move under their number, wide footage becomes `fit:
"contain"` or gets a `focus`. Check the other format with a `still`, don't assume.

**Facts.** Give the clip 2–5 `facts`: what it's for, its tone, the brand's colors and typeface, any rule the
person stated. Claude gets them with every change made in the editor.

## 3. Verify and look

```
node scripts/clips.mjs verify <project>
node scripts/clips.mjs still <project> <seconds> [--format 9:16]
```

1. **verify** checks the format and the files, prints the clip scene by scene, and warns about what will surprise.
   Fix every error; deal with each warning or know why it's fine.
2. **Look at it.** `still` draws one frame with the editor's own engine and prints the picture's path: read it.
   Look at 4–6 moments: the middle of each kind of scene, a moment just after type has come in (is it readable,
   does it fit?), and the same moments in each other format. A pass from `verify` means the file is well-formed,
   not that the clip looks right. Fix what you see and look again.

Don't build the final video unless asked: the person will want to adjust first.

## 4. Hand over

Start the editor and leave it running (in the background):

```
node scripts/clips.mjs serve <project>
```

It prints the address (http://localhost:5320, or the next free port). If it prints a `TELL` line, Claude Code
isn't connected: offer the step from 0, as optional.

Tell the person, briefly and in plain words:
- what you made: the scenes in a line each, the length, the formats;
- that the editor has layers and media on the left, the frame and the timeline in the middle, values on the right;
- that they can drag a layer on the frame, drag bars and their edges on the timeline, press **S** to cut a scene
  at the playhead and **Space** to play; every hand edit is free and can be stepped back (⌘Z, or **History**);
- that the format switch at the top shows the same clip in each format, and a move made there is for that format;
- that a change typed in the bar under the frame goes to Claude with only the picked scene and comes back as a
  card in **AI changes** to keep, undo or refine;
- that **Build video** (top right) builds the checked formats into the clip's `renders/` folder.

End the message with the link alone in a `text` block, after "Open it in Chrome":

```text
http://localhost:5320
```

Give the address the server printed, never a guess. In the Claude desktop app the link also opens in the preview
beside the chat; building the video there may not work, so if **Build video** fails in the preview, the same
link in Chrome is the way.

## Changing a clip from the chat

When the person asks you (here, not in the editor) to change a clip: edit `clip.json` directly, then `verify`, and
look at a `still` of what you changed. The running editor picks the file up by itself and keeps the earlier state
in History. Keep the ids that still fit: the editor's cards hang on them.

To build the video from the chat:

```
node scripts/clips.mjs render <project> [--formats 16:9,9:16] [--quality draft|high|max]
```

It builds in a headless Chrome with the same engine and prints each file's path.

## A live site in a clip

A `site` layer records a page frame by frame from a script of actions (scroll, pointer, click), so even a heavy
WebGL scene comes out smooth. It is the one thing that needs ffmpeg (`sh scripts/install-ffmpeg.sh`, the person
runs it). Write the layer as `reference/clip-format.md` says, then `node scripts/clips.mjs record <project>`.
Without ffmpeg, the person can record a tab themselves in the plain web version of the editor, or bring a screen
recording as a file.

## What it can't do yet

Say these plainly when they come up, rather than working around them:
- Keyframes beyond one `move` per layer, masks, blend modes, color correction, speed ramps, text on a path.
- Charts beyond what a few shapes make: no pie, no line chart, no axes.
- Waveforms, cutting to the beat, voice-over recording, captions from speech.
- Output other than MP4 (H.264). Sound is AAC where Chrome can encode it and Opus otherwise (QuickTime doesn't
  play Opus; the editor says which one a file got).
- Video in ProRes or HEVC as input: Chrome doesn't play it. Ask for an H.264 MP4.
