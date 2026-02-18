# ⚡ Chrome Macro Recorder

A Chrome extension that records your browser interactions (clicks, typing, dropdowns) and replays them automatically — like a macro, across page loads.

## Features

- 🔴 **Record** clicks, text input, and select changes
- ▶ **Replay** with smart element waiting (handles slow/dynamic pages)
- 💾 **Save** named macros for reuse
- 🔄 **Cross-page** — continues replay after page navigation
- 🎯 **Smart selectors** — tries ID, aria-label, name, text content, then CSS path

## Install

1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this folder

## Usage

1. Click the extension icon in the toolbar
2. Hit **🔴 Record** and do your workflow on any page
3. Click, type, use dropdowns — even navigate to other pages
4. Hit **⏹ Stop** when done
5. Name it and **💾 Save**
6. Next time: open popup → click **▶ Play**

## How It Works

| Component | Role |
|-----------|------|
| `content.js` | Injected into every page; captures events and replays actions |
| `background.js` | Coordinates state across tabs; resumes replay after navigation |
| `popup.html/js` | UI for record/stop/play/save |

### Selector Strategy (priority order)
1. `#id`
2. `[data-testid="..."]`
3. `[aria-label="..."]`
4. `[name="..."]` (inputs)
5. Text content match (buttons/links)
6. CSS path (nth-of-type)

## Limitations

- **Iframes** with different origins can't be accessed (browser security)
- **Shadow DOM** elements may not be captured
- Works best on standard HTML pages; heavy React/Vue apps may have some misses

## File Structure

```
macro-recorder/
├── manifest.json
├── background.js   # Service worker, state & replay coordinator
├── content.js      # Event capture + replay executor
├── popup.html      # Extension popup UI
├── popup.js        # Popup logic
├── popup.css       # Styles
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
