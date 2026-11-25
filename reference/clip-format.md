# The clip format

A clip is one file, `clip.json`, next to a `media/` folder. The editor, the render and Claude all read and write this
file; nothing else describes the clip. `app/js/model.mjs` is the code that checks it (`validate`), and
`reference/example.clip.json` is a complete example.

## Units

| What | Unit |
|---|---|
| Time | seconds |
| Position (`x`, `y`) | percent of the frame, from its center. `x: 0, y: 0` is the middle; `y: 40` is near the bottom |
| Box (`box.w`, `box.h`), `maxWidth` | percent of the frame |
| Text `size`, `radius` | design pixels: the frame's short side is 1080 of them in every format, so `size: 96` looks the same weight in 16:9 and 9:16 |
| `scale` | 1 is as it is |

## The clip

```json
{
  "version": 1,
  "name": "LITHOS — case film",
  "fps": 30,
  "format": "16:9",
  "formats": ["16:9", "9:16"],
  "background": "#080808",
  "facts": ["For the Behance case. Calm pace, no hard cuts."],
  "fonts": ["Unbounded", { "family": "Brand Sans", "src": "media/BrandSans.woff2" }],
  "scenes": [],
  "audio": []
}
```

- `format` is the main format: the one a layer's own `x`, `y`, `scale`… describe. `formats` lists every format the
  clip is made in (the main one included). Formats: `16:9` 1920×1080, `9:16` 1080×1920, `1:1` 1080×1080, `4:5` 1080×1350.
- `fps`: 24, 25, 30, 50 or 60.
- `facts`: 0–8 lines Claude gets with every change made in the editor: what the clip is for, its tone, its rules.
- `fonts`: Google Fonts family names, or a font file in `media/`. Instrument Sans is always there.

## Scenes

Scenes play one after another; the clip's length is the sum of their durations.

```json
{
  "id": "hero",
  "label": "Hero interaction",
  "duration": 6,
  "background": "#080808",
  "transition": { "type": "fade", "duration": 0.5 },
  "layers": []
}
```

- `transition` is how this scene comes in over the one before it: `cut` (the default), `fade`, `slide-left`,
  `slide-up`, `zoom`, `wipe`. It happens inside this scene's first `duration` seconds, so it never changes the
  clip's length; the scene before keeps running underneath. The first scene has none.
- `layers` are drawn in order: the last one is on top.

## Layers

Every layer:

| Field | Meaning |
|---|---|
| `id` | unique in the whole clip; lowercase latin letters, digits, hyphens |
| `kind` | `video`, `image`, `text`, `shape`, `site` |
| `label` | the name a designer sees |
| `start`, `duration` | when it is on, inside its scene. No `start`: from the scene's start. No `duration`: to the scene's end |
| `x`, `y`, `scale`, `rotate`, `opacity`, `radius` | how it sits |
| `enter`, `exit` | `{ "type", "duration", "ease" }`. Types: `fade`, `up`, `down`, `left`, `right`, `scale`, `blur`, and `grow-x` / `grow-y`, which uncover the layer from its left edge / from its foot (a bar that grows, a rule that draws itself) |
| `move` | `{ "from": { x, y, scale }, "to": { x, y, scale }, "ease" }`: a slow pan or zoom over the layer's whole life, added to its own `x`, `y`, `scale` |
| `formats` | how another format places this layer: `{ "9:16": { "fit": "contain", "y": -10 } }` |

Eases: `linear`, `in`, `out`, `inOut`, `expoOut`, `backOut`.

A format override may change only placement: `x`, `y`, `scale`, `rotate`, `fit`, `box`, `size`, `maxWidth`, `align`,
`focus`, `hidden`. What a layer is (its file, its words, its timing) is the same in every format.

### video

```json
{ "id": "hero-rec", "kind": "video", "src": "media/hero.mp4", "trim": { "in": 2.5 }, "speed": 1.5, "volume": 0,
  "fit": "cover", "focus": { "x": 50, "y": 30 }, "box": { "w": 100, "h": 100 } }
```

- `trim.in`: where in the file it starts. How much of the file plays is the layer's duration × `speed`.
- `volume`: 0 (the default) is silent; up to 2.
- `fit`: `cover` fills the box and crops; `contain` shows all of it. `focus` says which part stays in view when
  `cover` crops (percent; `50, 50` is the middle). In a vertical format, `focus` is usually what needs changing.
- A video past its file's end holds its last frame.

### image

`src`, `fit`, `focus`, `box`, as for video. Give a still picture a `move` so it isn't frozen.

### text

```json
{ "id": "title", "kind": "text", "text": "LITHOS®\nA living surface", "font": "Unbounded", "size": 110, "weight": 600,
  "color": "#ffffff", "align": "center", "maxWidth": 84, "letterSpacing": -0.02, "lineHeight": 1.05, "uppercase": false }
```

`\n` breaks a line. The block is placed by its center.

**Kinetic type.** `animate` brings the text in piece by piece:

```json
{ "id": "claim", "kind": "text", "text": "Design that moves", "size": 140, "weight": 600,
  "animate": { "by": "word", "type": "up", "stagger": 0.09, "duration": 0.6, "ease": "expoOut" } }
```

`by`: `line`, `word` or `letter`. `type`: `fade`, `up`, `down`, `scale`, `blur`. `stagger` is the time between one
piece starting and the next; `duration` is how long each piece takes. Use `animate` in place of `enter`.

**A number that counts.** Put `{n}` where the number goes and say what it counts:

```json
{ "id": "stat", "kind": "text", "text": "{n}%", "size": 300, "weight": 700,
  "count": { "from": 0, "to": 87, "decimals": 0, "duration": 1.4, "ease": "expoOut" } }
```

Thousands are set apart with a thin space (`"group": false` turns that off); `"comma": true` writes the decimal
mark as a comma.

### shape

`{ "kind": "shape", "shape": "rect", "fill": "#7548d9", "box": { "w": 30, "h": 8 }, "radius": 40 }`: a plate under
text, a bar, a mask of color. `shape` is `rect` (the default) or `ellipse`.

Infographics are a few of these placed by hand. A bar chart is rects on a common baseline, each with
`"enter": { "type": "grow-y", "duration": 0.7, "ease": "expoOut" }` and a `start` a little later than the one before:

```json
{ "id": "bar-2", "kind": "shape", "fill": "#ffffff", "box": { "w": 5, "h": 34 }, "radius": 14, "x": 25, "y": 3,
  "start": 0.42, "enter": { "type": "grow-y", "duration": 0.7, "ease": "expoOut" } }
```

A bar's foot is at `y + h/2`: to stand bars of different heights on one line, give them the same `y + h/2`.

### site

A live page, recorded into a video by the studio's scripted recorder. This is the one layer that needs ffmpeg on
the computer, and it is recorded from the command line (`node scripts/clips.mjs record <project>`) or with the
layer's Record button in the editor.

```json
{
  "id": "hero-site", "kind": "site", "label": "Home page",
  "url": "http://localhost:5173",
  "viewport": { "width": 1920, "height": 1080 },
  "cursor": true,
  "settle": 1.5,
  "actions": [
    { "do": "wait", "for": 1 },
    { "do": "scroll", "to": "#work", "offset": 80, "for": 2.5, "ease": "inOut" },
    { "do": "move", "to": ".card:nth-child(2)", "for": 0.8 },
    { "do": "wait", "for": 1.2 },
    { "do": "click", "for": 0.4 },
    { "do": "scroll", "to": "bottom", "for": 4 }
  ]
}
```

| Action | Fields |
|---|---|
| `wait` | `for` |
| `scroll` | `to`: pixels from the top, `"bottom"`, `"top"`, or a CSS selector (its top, less `offset`); `for`; `ease` |
| `wheel` | `by` pixels, `for`, `ease`: wheel events, for pages with no real scroll (a WebGL story driven by the wheel) |
| `move` | `to`: a selector (its center) or `[x, y]` in the window; `for`. The page gets real pointer events, so hover states and pointer-driven scenes react |
| `click` | `to` (optional: else where the pointer is), `for` |
| `type` | `text`, `for` |
| `key` | `key`: `Enter`, `Escape`, `ArrowDown`… |

- The recording's length is the sum of the actions' `for`. Make the layer (or its scene) as long.
- `viewport`: the window the page is opened in; `scale` is the pixel density (a phone: `{ "width": 390, "height": 844, "scale": 3 }`).
- `cursor: true` draws a pointer. `scrollIn`: a selector, when the page scrolls inside an element and not the window.
  `settle`: seconds to wait after load before recording starts (an intro to skip, a heavy scene to warm up).
- Recording adds `recording` (the file in `media/recordings/`) and `recorded` (what it was made from). Never write
  those by hand. From then on the layer behaves as a video: `trim`, `speed`, `fit`, `focus`, `box` all apply.
  Change `url`, `viewport` or `actions` and it has to be recorded again.

**How the recording is made.** The page's clock is taken over: `requestAnimationFrame`, `performance.now`, `Date`,
timers, CSS animations and transitions, and videos on the page all move one frame at a time, and a picture is taken
after each step. So every frame is there, at any frame rate, however heavy the page is. What doesn't follow that
clock: audio, animation driven by a worker or by `AudioContext` time, and anything that waits on the network during
the recording.

## Audio

```json
{ "id": "music", "src": "media/track.mp3", "start": 0, "trimIn": 12, "duration": 20, "volume": 0.8, "fadeIn": 0.5, "fadeOut": 1.5 }
```

Tracks run over the whole clip, across scenes. No `duration`: to the clip's end.

## Files

Every `src` is a path that starts with `media/`. Add files with `node scripts/clips.mjs add <project> <file>…` (or by
dropping them on the editor). Chrome has to be able to play a video for the editor to show and build it: H.264 MP4
and WebM work; ProRes and HEVC don't (where ffmpeg is installed, `add` converts those to H.264 on the way in and
keeps the original in `media/originals/`).
