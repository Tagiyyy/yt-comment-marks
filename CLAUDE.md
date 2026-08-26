# CLAUDE.md - Developer Guide for AI Assistants

## Project Overview

**YouTube Comment Timestamp Markers** (`yt-comment-marks`) is a Chrome extension (Manifest V3) that scans YouTube video comments for timestamps and renders interactive orange markers on the native progress bar. Clicking a marker seeks to that position; hovering shows a tooltip with nearby comment text.

- **Version:** 0.1.2
- **License:** MIT (Copyright 2025 @Tagiyyy)
- **Locales:** English (default), Japanese

## Repository Structure

```
yt-comment-marks/
├── manifest.json              # Chrome extension manifest (MV3)
├── src/
│   ├── content.js             # Core content script (~650 lines) - all extension logic
│   ├── logger.js              # Debug logging utility (localStorage toggle, no permissions)
│   └── overlay.css            # Marker and tooltip styles
├── _locales/
│   ├── en/messages.json       # English i18n strings
│   └── ja/messages.json       # Japanese i18n strings
├── icons/                     # Extension icons (16, 32, 48, 128 px)
├── README.md                  # User-facing documentation (bilingual JP/EN)
└── LICENSE                    # MIT license
```

## Build System

**There is no build step.** The project uses vanilla JavaScript with no bundler, transpiler, package manager, or npm dependencies. Source files are loaded directly by Chrome via `manifest.json`.

## Development Workflow

1. Edit source files in `src/`
2. Go to `chrome://extensions`, enable "Developer mode"
3. Click "Load unpacked" and select the repository root
4. After changes, click "Update" on the extension card and refresh YouTube
5. Debug logging is **off by default**. To enable it, run `localStorage.ytcm_debug = '1'` in the DevTools console on any YouTube page and reload, then filter the console for `[YT-CM]`. `delete localStorage.ytcm_debug` turns it back off. (`YTCM_LOG.setEnabled(true)` does the same, but only from the extension's isolated world context.) The flag is read synchronously at script start, so it covers the very first log lines

## Architecture

The extension runs as two content scripts (`src/logger.js`, then `src/content.js`) injected at `document_idle` on all `youtube.com` pages.

### Execution Flow

```
init() → boot()                     # boot() no-ops unless location.pathname === '/watch'
  ├── observeCommentSection(token)  # MutationObserver on #comments #contents
  │     └── processCommentNode()    # For each new/existing comment
  │           ├── Find <a> anchors that point at the *current* video
  │           ├── extractTextBetween() + pickSnippet() → tooltip text
  │           └── addMarker() → appends .ytcm-marker to .ytp-progress-bar
  │                 returns false when it cannot draw yet (retry on the next scan)
  └── waitVideoReadyThenScan(token) # Polls for <video> (bounded), scans, then keeps
        └── loadedmetadata / durationchange → rescanAll() → clear + redraw markers

handleNavigation()                  # Listens for 'yt-navigate-finish' (YouTube SPA nav)
  ├── teardown()                    # Markers, observers, timers, video listeners
  └── boot()                        # Skipped when leaving the watch page
```

### Key State

| Variable | Type | Purpose |
|---|---|---|
| `processedNodes` | `WeakMap<Node, string>` | Maps a comment node to the text it was processed with, so recycled nodes and retries are re-parsed |
| `commentObserver` | `MutationObserver` | Watches for lazy-loaded comments |
| `currentVideoId` | `string\|null` | Detects navigation between videos (null when off the watch page) |
| `bootToken` | `number` | Generation counter that invalidates async waits after a navigation |
| `lastRenderedDuration` | `number` | Duration the current markers were positioned against |
| `watchedVideo` | `HTMLVideoElement` | Video the metadata/duration listeners are attached to |

### Retry Model

`addMarker()` returns `false` for *transient* failures (no `<video>`, `duration` still `NaN`/`Infinity`, an ad is playing, no progress bar). `processCommentNode()` then leaves the node out of `processedNodes`, so the next scan retries it. It returns `true` when the timestamp was drawn, deduplicated, or is genuinely out of range — all permanent outcomes for this video.

### Timestamp Parsing

Two formats are supported:
- **Text-based:** `MM:SS` or `HH:MM:SS` matched by `timestampRegex`
- **URL parameter:** `t=` or `start=` params in YouTube URLs (e.g., `1h2m3s`, `90s`, `123`)

Anchors are only considered when `isSameVideoLink()` says the `href` points at the video currently being watched. Links to other videos or external sites are skipped entirely — their timestamps do not correspond to any position on this progress bar, and clicking them would navigate away.

### Tooltip Text Selection

The `pickSnippet()` function chooses tooltip text with this priority:
1. Text on the **same line** as the timestamp (after-text preferred if both sides qualify)
2. Nearest line before or after the timestamp (fallback)

### Marker Deduplication

Markers within 0.2% of each other on the progress bar are considered duplicates and skipped.

## Code Conventions

### Style

- **2-space indentation**, semicolons on all statements
- **camelCase** for all variables and functions
- Code comments are mostly in **Japanese**; function JSDoc is mixed JP/EN
- All source files start with an **SPDX license header:**
  ```js
  /* SPDX-License-Identifier: MIT
     Copyright (c) 2025 @Tagiyyy
  */
  ```

### Patterns

- **IIFE wrapping** — all scripts use `(function(){ ... })()` to avoid global leaks
- **WeakMap for tracking** — prevents double-processing while allowing GC, and stores the processed text so changed/recycled nodes are re-parsed
- **Defensive null checks** — every DOM query is guarded (`if (!el) return`)
- **Promise-based element waiting** — `waitForElement()` uses MutationObserver + timeout
- **Event delegation for clicks** — markers dispatch a synthetic click on the original `<a>` element; falls back to direct `video.currentTime` seek
- **CSS custom properties** — `--ytcm-shift` dynamically repositions tooltips to prevent overflow

### DOM Selectors Used

| Selector | Purpose |
|---|---|
| `#comments #contents` | Comment section container |
| `#content-text` | Individual comment text node |
| `.ytp-progress-bar` | YouTube's native progress bar (marker parent) |
| `video` | HTML5 video element |
| `.html5-video-player` | Player container (tooltip boundary) |

### CSS Classes

| Class | Element | Description |
|---|---|---|
| `.ytcm-marker` | `div` | Orange gradient marker on progress bar, 10px wide, centered on its timestamp with `margin-left: -5px`, z-index 1000 |
| `.ytcm-tooltip` | `div` | Dark tooltip above marker, max-width 640px, hidden by default |

## Permissions

The extension declares **no `permissions` at all** — only `host_permissions` for `https://www.youtube.com/*`. It uses no `chrome.*` API: `logger.js` persists its debug flag in the page's `localStorage` (same origin as the content script), specifically so that the `storage` permission is not needed. Keep it that way — prefer a permission-free approach over adding to the manifest. No background service worker and no network access.

## Testing

There is no automated test framework. Testing is manual:
1. Load the extension in Chrome developer mode
2. Visit YouTube videos that have comments containing timestamps
3. Verify markers appear on the progress bar
4. Check tooltips display on hover
5. Check click-to-seek works
6. Verify markers clean up on navigation to a different video

Regression scenarios worth re-checking after touching `content.js`:

- **Comments before metadata** — reload a watch page and scroll to the comments immediately; markers must still appear once the video's duration is known
- **Pre-roll / mid-roll ad** — markers must not be drawn against the ad's duration, and must appear (or reappear) once the ad finishes
- **Live stream** — no markers, and none stacked at 0%
- **Cross-video links** — a comment linking to a *different* video with `&t=` must not create a marker
- **Navigation** — watch → home → back to the same video must re-create markers; leaving a watch page must remove them
- **Non-watch pages** — the home page must not leave timers or MutationObservers running

## Internationalization

Strings in `manifest.json` use `__MSG_keyName__` syntax resolved from `_locales/{lang}/messages.json`. Only three keys exist: `extName`, `extDesc`, `actionTitle`.

## Things to Watch Out For

- YouTube's DOM structure can change — selectors like `.ytp-progress-bar` and `#comments #contents` may break with YouTube updates
- The content script is injected on **all** youtube.com pages, but `boot()` returns immediately unless the path is `/watch` — never start unbounded polling or observers outside a watch page
- YouTube uses SPA navigation — the `yt-navigate-finish` custom event is the only reliable way to detect page changes. `handleNavigation()` also fires when *leaving* a watch page (`getVideoId()` returns `null`), which must tear everything down
- During an ad, `video.duration` is the **ad's** duration; `addMarker()` refuses to draw while `.html5-video-player.ad-showing` is present and relies on the `durationchange` rescan afterwards
- Live streams report `duration === Infinity`; markers are intentionally not drawn for them
- `Range.toString()` drops `<br>` elements, so `extractTextBetween()` clones the range and replaces `<br>` with newlines — the line-based tooltip selection depends on those newlines
- `logger.js` is loaded before `content.js` in the manifest, and debug logging defaults to **off** (flag: `localStorage.ytcm_debug`); `content.js` still falls back to `console.log` if the logger is missing
