# CLAUDE.md - Developer Guide for AI Assistants

## Project Overview

**YouTube Comment Timestamp Markers** (`yt-comment-marks`) is a Chrome extension (Manifest V3) that scans YouTube video comments for timestamps and renders interactive orange markers on the native progress bar. Clicking a marker seeks to that position; hovering shows a tooltip with nearby comment text.

- **Version:** 0.1.1
- **License:** MIT (Copyright 2025 @Tagiyyy)
- **Locales:** English (default), Japanese

## Repository Structure

```
yt-comment-marks/
├── manifest.json              # Chrome extension manifest (MV3)
├── src/
│   ├── content.js             # Core content script (~480 lines) - all extension logic
│   ├── logger.js              # Debug logging utility with chrome.storage toggle
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
5. Open DevTools on a YouTube page and filter console for `[YT-CM]` to see debug output

## Architecture

The extension runs as a single content script (`src/content.js`) injected at `document_idle` on all `youtube.com` pages.

### Execution Flow

```
init() → boot()
  ├── observeCommentSection()     # MutationObserver on #comments #contents
  │     └── processCommentNode()  # For each new/existing comment
  │           ├── Find <a> anchors with timestamp text or t=/start= URL params
  │           ├── extractTextBetween() + pickSnippet() → tooltip text
  │           └── addMarker() → appends .ytcm-marker to .ytp-progress-bar
  └── waitVideoReadyThenScan()    # Waits for video metadata then re-scans

handleNavigation()                # Listens for 'yt-navigate-finish' (YouTube SPA nav)
  ├── cleanupMarkers()            # Removes all .ytcm-marker elements, resets WeakSet
  └── boot()                      # Re-initializes for the new video
```

### Key State

| Variable | Type | Purpose |
|---|---|---|
| `processedNodes` | `WeakSet` | Tracks already-processed comment DOM nodes |
| `commentObserver` | `MutationObserver` | Watches for lazy-loaded comments |
| `currentVideoId` | `string` | Detects navigation between videos |

### Timestamp Parsing

Two formats are supported:
- **Text-based:** `MM:SS` or `HH:MM:SS` matched by `timestampRegex`
- **URL parameter:** `t=` or `start=` params in YouTube URLs (e.g., `1h2m3s`, `90s`, `123`)

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
- **WeakSet for tracking** — prevents double-processing while allowing GC
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
| `.ytcm-marker` | `div` | Orange gradient marker on progress bar, 10px wide, z-index 1000 |
| `.ytcm-tooltip` | `div` | Dark tooltip above marker, max-width 640px, hidden by default |

## Permissions

The extension requests only `host_permissions` for `https://www.youtube.com/*`. No storage, background, or network permissions are declared in the manifest (though `logger.js` uses `chrome.storage.sync` opportunistically with try-catch).

## Testing

There is no automated test framework. Testing is manual:
1. Load the extension in Chrome developer mode
2. Visit YouTube videos that have comments containing timestamps
3. Verify markers appear on the progress bar
4. Check tooltips display on hover
5. Check click-to-seek works
6. Verify markers clean up on navigation to a different video

## Internationalization

Strings in `manifest.json` use `__MSG_keyName__` syntax resolved from `_locales/{lang}/messages.json`. Only three keys exist: `extName`, `extDesc`, `actionTitle`.

## Things to Watch Out For

- YouTube's DOM structure can change — selectors like `.ytp-progress-bar` and `#comments #contents` may break with YouTube updates
- The content script runs on **all** youtube.com pages, not just watch pages; it gracefully no-ops when there's no video/comments
- YouTube uses SPA navigation — the `yt-navigate-finish` custom event is the only reliable way to detect page changes
- `logger.js` must be loaded before `content.js` if debug logging through `window.YTCM_LOG` is desired, but `content.js` has a fallback to `console.log` if the logger isn't available
- Note: `logger.js` is **not** listed in `manifest.json`'s content scripts — it is currently unused at runtime unless manually injected
