# Next Up

**Your visual action inbox for the browser.**

Next Up replaces your new tab page with a personal board of things you want to do. Capture screenshots from any webpage, write actionable steps, and organize everything by intention. It's like a visual todo list that lives in your browser.

No server. No account. No external API calls. 100% local Chrome extension.

> Forked from [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out) and rebuilt into a visual action system.

---

![Next Up Dashboard](assets/dashboard.png)

---

## What it does

1. **Browse any page** and click the Next Up icon in the toolbar
2. **Capture a region** of the page (drag to select, like CleanShot)
3. **Write an action step** — what you want to do with this page
4. **Pick an intention** — Read Later, To Practice, Deep Dive, or your own custom categories
5. **Open a new tab** — your visual board shows all saved cards, filterable by intention
6. **Click a card** to open a WYSIWYG editor — track progress with markdown, checkboxes, and inline images

![Next Up Editor](assets/editor.png)

---

## Features

### Visual Action Cards
- **Region screenshot capture** — drag to select any part of a webpage
- **Cmd+V to create** — paste any image from clipboard to create a card instantly
- **Rich card grid** — screenshots, action steps, intention badges, domain info

### Intention System
- **Custom categories** — create your own (e.g. "Coding Project", "GEO", "Spanish")
- **Filter tabs** — click an intention to filter your board
- **Inline creation** — add new intentions from anywhere (popup, dashboard, paste modal)

### WYSIWYG Editor
- **Click any card** to open a full editor with blur backdrop
- **Markdown shortcuts** — type `- ` for bullets, `[] ` for checkboxes, `## ` for headings
- **Keyboard shortcuts** — Cmd+B bold, Cmd+I italic, Cmd+K link
- **Paste images** — Cmd+V inside the editor to embed screenshots
- **Auto-save** — saves as you type, no manual save needed

### Everything Else
- **Open tabs view** — collapsible section showing all browser tabs grouped by domain
- **Confetti + swoosh** — satisfying animations when closing tabs
- **Duplicate detection** — flags when you have the same page open twice
- **100% local** — all data in `chrome.storage.local`, nothing leaves your machine

---

## Setup

**1. Clone the repo**

```bash
git clone https://github.com/AOMJ2PMP/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

**3. Open a new tab**

You'll see Next Up.

---

## How it works

```
Browse a page
  → Click Next Up icon → Capture region screenshot
  → Write action step → Pick intention → Save
  → Open new tab → See your visual board
  → Click card → WYSIWYG editor → Track progress
  → Done? Check it off with confetti
```

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Markdown | marked.js |
| Editor | contenteditable WYSIWYG |
| Screenshot | chrome.tabs.captureVisibleTab + OffscreenCanvas crop |
| Region select | Content script with drag overlay |
| Sound | Web Audio API (synthesized) |
| Fonts | Fraunces (serif) + SN Pro (sans) + LXGW WenKai (CJK) |

---

## License

MIT

---

Forked from [Next Up](https://github.com/zarazhangrui/tab-out) by [Zara](https://x.com/zarazhangrui). Rebuilt by Lux.
