/* capture.js — Content Script: Region Screenshot Capture
 *
 * Injected into the active tab when user clicks "📸 Capture" in the popup.
 * Creates a fullscreen overlay with crosshair cursor. User drags to select
 * a rectangle. On mouseup, sends the region coordinates back to the
 * background script, which captures the visible tab and crops to the region.
 *
 * Messages:
 *   IN:  { action: 'start-capture' }         → show overlay
 *   OUT: { action: 'region-selected', rect }  → region coords
 *   OUT: { action: 'capture-cancelled' }      → user pressed Escape
 */

(function() {
  'use strict';

  // Prevent double-injection
  if (window.__tabOutCaptureActive) return;
  window.__tabOutCaptureActive = true;

  // ── Create overlay ──────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__tabout-capture-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'rgba(0, 0, 0, 0.15)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  });

  // Selection rectangle
  const selBox = document.createElement('div');
  Object.assign(selBox.style, {
    position: 'fixed',
    border: '2px solid #c8713a',
    borderRadius: '3px',
    background: 'rgba(200, 113, 58, 0.08)',
    pointerEvents: 'none',
    display: 'none',
    zIndex: '2147483647',
  });
  overlay.appendChild(selBox);

  // Instruction tooltip
  const tooltip = document.createElement('div');
  tooltip.textContent = 'Drag to select a region · Esc to cancel';
  Object.assign(tooltip.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#1a1613',
    color: '#f8f5f0',
    fontFamily: "'DM Sans', -apple-system, sans-serif",
    fontSize: '13px',
    fontWeight: '500',
    padding: '8px 16px',
    borderRadius: '8px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
  });
  overlay.appendChild(tooltip);

  document.documentElement.appendChild(overlay);

  // ── State ───────────────────────────────────────────────────────────
  let startX = 0, startY = 0;
  let dragging = false;

  // ── Helpers ─────────────────────────────────────────────────────────
  function cleanup() {
    overlay.remove();
    window.__tabOutCaptureActive = false;
    document.removeEventListener('keydown', onKeydown, true);
  }

  function getRect(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width:  Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  // ── Mouse events ────────────────────────────────────────────────────
  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    selBox.style.display = 'block';
    selBox.style.left   = startX + 'px';
    selBox.style.top    = startY + 'px';
    selBox.style.width  = '0px';
    selBox.style.height = '0px';
  }, true);

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const rect = getRect(startX, startY, e.clientX, e.clientY);
    selBox.style.left   = rect.x + 'px';
    selBox.style.top    = rect.y + 'px';
    selBox.style.width  = rect.width + 'px';
    selBox.style.height = rect.height + 'px';
  }, true);

  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;

    const rect = getRect(startX, startY, e.clientX, e.clientY);

    // Ignore tiny clicks (< 10px in any dimension)
    if (rect.width < 10 || rect.height < 10) {
      selBox.style.display = 'none';
      return;
    }

    // Account for device pixel ratio for accurate cropping
    const dpr = window.devicePixelRatio || 1;
    const scaledRect = {
      x:      Math.round(rect.x * dpr),
      y:      Math.round(rect.y * dpr),
      width:  Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    };

    cleanup();

    // Send the region to the background script
    chrome.runtime.sendMessage({
      action: 'region-selected',
      rect: scaledRect,
    });
  }, true);

  // ── Keyboard: Escape to cancel ──────────────────────────────────────
  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      chrome.runtime.sendMessage({ action: 'capture-cancelled' });
    }
  }
  document.addEventListener('keydown', onKeydown, true);

})();
