# PixelText

[English](README.md) | [한국어](README.ko.md)

**An offline, infinite text canvas where text can live at any coordinate.**

[![CI](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml/badge.svg)](https://github.com/c21senseman/PixelText/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/c21senseman/PixelText?label=release)](https://github.com/c21senseman/PixelText/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Download the latest `pixeltext.html`](https://github.com/c21senseman/PixelText/releases/latest/download/pixeltext.html)

PixelText is a Canvas-based editor for writing and organizing text anywhere in a two-dimensional cell space instead of being confined to document lines. It needs no installation, account, or server, and supports Korean IME input and emoji grapheme clusters.

## Get started

1. Select **Download the latest `pixeltext.html`** above.
2. Open the downloaded file in a modern browser.
3. Click the canvas and start typing. Your work is saved automatically in the current browser profile.

> Clearing browser site data or deleting the browser profile can remove the autosaved document. Export important work as JSON from the top menu before doing so.

## Features

- Boundary-free text canvas backed by sparse 64×64 chunks
- Text model that distinguishes unstored empty cells from one-cell gaps between characters
- Insert and overwrite modes, line splitting with Enter, and pulling with Backspace/Delete
- Bold, italic, underline, strikethrough, and natural-number font sizes (base size 1; no preset upper limit) with selection and cursor synchronization
- Mixed-size text layout, visual vertical navigation, and formatting-preserving copy and paste within PixelText
- Rectangular selections, four-edge resizing, and automatic text reflow
- Copy and paste, plus horizontal or vertical push and overwrite movement
- Undo and redo, canvas-wide search, bookmarks, and a minimap
- Large positive and negative coordinates with 5%–400% zoom
- PixelText JSON import/export and plain-text export

## Controls

| Task | Control |
| --- | --- |
| Type | Click the canvas and start typing |
| Pan | Drag with the right or middle mouse button |
| Scroll | Mouse wheel along the last pan axis (vertical by default) |
| Zoom | `Ctrl` + mouse wheel |
| Rectangular selection | Drag across the canvas |
| Resize a selection | Drag its top, bottom, left, or right edge |
| Toggle insert/overwrite | `Insert` |
| Bold / italic / underline | `Ctrl/Cmd+B` / `Ctrl/Cmd+I` / `Ctrl/Cmd+U` |
| Font size | Enter a toolbar size and press Enter, or use A− / A+ |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |

Open the in-app help panel for the complete controls, including minimap and selection movement.

Formatting applies to selected text or subsequent typing. Font sizes are whole-number multipliers: size 2 uses twice the width and height of size 1. The 12×24px base grid stays fixed during editing, selection, and dragging. Mixed font sizes show an empty size field with a mixed placeholder. Autosave and JSON preserve formatting; older documents remain readable, with pixel sizes rounded to the nearest natural-number multiplier (minimum 1). TXT and external plain-text paste use unformatted text.

## Data and privacy

The release build runs entirely in your browser, with no backend, login, or remote analytics. Documents are autosaved to IndexedDB. Imported JSON is validated for structure, coordinates, graphemes, bookmarks, and resource limits before it is applied; a failed import leaves the current document unchanged.

See the [security policy](SECURITY.md) for vulnerability reporting instructions.

## Local development

Node.js 22.13.0 or later is required.

```bash
git clone https://github.com/c21senseman/PixelText.git
cd PixelText
npm ci
npm run dev
```

Run every validation step with one command:

```bash
npm run check
```

Individual commands are also available:

| Command | Purpose |
| --- | --- |
| `npm test` | Run editor engine tests |
| `npm run typecheck` | Check TypeScript types |
| `npm run lint` | Run ESLint |
| `npm run build` | Build the standalone `dist/index.html` |
| `npm run start` | Preview the production build |

## Project structure

| Path | Role |
| --- | --- |
| `src/` | React UI and styles |
| `lib/` | Document model, editing commands, renderer, storage, and file I/O |
| `tests/` | Editor engine and document format tests |
| `build/` | Vite plugin that inlines JavaScript and CSS into one HTML file |
| `spec.md` | Feature and data model specification |
| `ux.md` | Interaction principles and UX specification |

## Release build

```bash
npm ci
npm run check
```

The output is the single file `dist/index.html`. It contains the React runtime, editor code, styles, and icons, so it can be distributed without a server or separate static assets and opened offline. See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

PixelText is available under the [MIT License](LICENSE).
