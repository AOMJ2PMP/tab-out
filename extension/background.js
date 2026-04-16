/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Region Screenshot Capture ───────────────────────────────────────────────

/**
 * Listens for messages from capture.js (content script) and popup.js.
 *
 * Flow:
 * 1. Popup sends 'start-capture' → we inject capture.js into the active tab
 * 2. User drags a region → capture.js sends 'region-selected' with rect
 * 3. We captureVisibleTab, crop to rect using OffscreenCanvas, send back base64
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Step 1: Popup asks to start capture ──
  if (msg.action === 'start-capture') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['capture.js'],
        });
      } catch (err) {
        console.warn('[tab-out] Could not inject capture script:', err);
      }
    })();
    return false;
  }

  // ── Step 2: Content script reports selected region ──
  if (msg.action === 'region-selected' && msg.rect) {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        // Capture the visible area of the tab
        const dataUrl = await chrome.tabs.captureVisibleTab(null, {
          format: 'png',
        });

        // Crop to the selected region using OffscreenCanvas
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        const bmp  = await createImageBitmap(blob);

        const r = msg.rect;
        // Clamp to image bounds
        const sx = Math.max(0, Math.min(r.x, bmp.width));
        const sy = Math.max(0, Math.min(r.y, bmp.height));
        const sw = Math.min(r.width, bmp.width - sx);
        const sh = Math.min(r.height, bmp.height - sy);

        const canvas = new OffscreenCanvas(sw, sh);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);

        const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });

        // Convert blob to data URL
        const croppedDataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(croppedBlob);
        });

        // Store the screenshot so the popup can retrieve it on open
        await chrome.storage.local.set({ __pendingScreenshot: croppedDataUrl });

        // Auto-reopen the popup so user can fill in action step + intention
        try {
          await chrome.action.openPopup();
        } catch {
          // openPopup may fail if not supported or user gesture required
          // User can still click the icon manually — screenshot is in storage
        }

      } catch (err) {
        console.error('[tab-out] Screenshot capture failed:', err);
      }
    })();
    return false;
  }

  // ── User cancelled capture ──
  if (msg.action === 'capture-cancelled') {
    chrome.storage.local.remove('__pendingScreenshot');
    return false;
  }

});


// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
