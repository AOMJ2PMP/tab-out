/* ================================================================
   Next Up — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Next Up's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Next Up's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Next Up new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Next Up tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   INTENTIONS — Custom user-defined categories

   Users can create intentions like "To Practice", "Read Later",
   "Deep Dive", etc. Tabs saved with an intention are grouped
   under that intention on the dashboard. Tabs saved without an
   intention go to the general "Saved for Later" list.

   Data shape stored under the "intentions" key:
   [
     { id: "practice",   label: "To Practice",    emoji: "🔧", order: 0 },
     { id: "read-later", label: "Read Later",     emoji: "📖", order: 1 },
     { id: "deep-dive",  label: "Deep Dive",      emoji: "🧘", order: 2 },
     { id: "casual",     label: "Just Browsing",  emoji: "👀", order: 3 },
   ]
   ---------------------------------------------------------------- */

const DEFAULT_INTENTIONS = [
  { id: 'practice',   label: 'To Practice',   emoji: '🔧', order: 0 },
  { id: 'read-later', label: 'Read Later',    emoji: '📖', order: 1 },
  { id: 'deep-dive',  label: 'Deep Dive',     emoji: '🧘', order: 2 },
  { id: 'casual',     label: 'Just Browsing', emoji: '👀', order: 3 },
];

/**
 * getIntentions()
 *
 * Returns user's intention categories. Seeds defaults on first use.
 */
async function getIntentions() {
  const { intentions } = await chrome.storage.local.get('intentions');
  if (!intentions || intentions.length === 0) {
    await chrome.storage.local.set({ intentions: DEFAULT_INTENTIONS });
    return DEFAULT_INTENTIONS;
  }
  return intentions.sort((a, b) => a.order - b.order);
}

/**
 * saveIntentions(intentions)
 *
 * Persists the full intentions array.
 */
async function saveIntentions(intentions) {
  await chrome.storage.local.set({ intentions });
}

/**
 * addIntention({ label, emoji })
 *
 * Adds a new intention. ID is auto-generated from label.
 */
async function addIntention({ label, emoji }) {
  const intentions = await getIntentions();
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const order = intentions.length;
  intentions.push({ id, label, emoji, order });
  await saveIntentions(intentions);
  return intentions;
}

/**
 * removeIntention(id)
 *
 * Removes an intention. Tabs with that intention become untagged.
 */
async function removeIntention(id) {
  let intentions = await getIntentions();
  intentions = intentions.filter(i => i.id !== id);
  // Re-order
  intentions.forEach((i, idx) => i.order = idx);
  await saveIntentions(intentions);
  // Clear intentionId from any saved tabs that had this intention
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  for (const item of deferred) {
    if (item.intentionId === id) item.intentionId = null;
  }
  await chrome.storage.local.set({ deferred });
  return intentions;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false,             // true = dismissed without reading
       intentionId: "deep-dive"      // optional — null = general "Saved for Later"
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab, intentionId)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 * @param {string|null} intentionId — optional intention category
 */
async function saveTabForLater(tab, intentionId = null) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:           Date.now().toString(),
    url:          tab.url,
    title:        tab.title,
    savedAt:      new Date().toISOString(),
    completed:    false,
    dismissed:    false,
    intentionId:  intentionId || null,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * setTabIntention(tabId, intentionId)
 *
 * Assigns or changes the intention on a saved tab.
 * Pass null to move it back to general "Saved for Later".
 */
async function setTabIntention(tabId, intentionId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === tabId);
  if (tab) {
    tab.intentionId = intentionId || null;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Next Up pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-tag" data-action="open-chip-intention-picker" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save with tag">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6Z" /></svg>
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-tag" data-action="open-chip-intention-picker" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save with tag">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6Z" /></svg>
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * column. Tabs with intentions are grouped under intention headers.
 * Tabs without intentions go under "Saved for Later".
 * Completed items go to a collapsible archive.
 */
async function renderDeferredColumn() {
  const column = document.getElementById('deferredColumn');
  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();
    const intentions = await getIntentions();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Group active items by intentionId
    const intentionTabs = {};   // intentionId -> [items]
    const generalTabs = [];     // items with no intention

    for (const item of active) {
      if (item.intentionId) {
        if (!intentionTabs[item.intentionId]) intentionTabs[item.intentionId] = [];
        intentionTabs[item.intentionId].push(item);
      } else {
        generalTabs.push(item);
      }
    }

    // Build the column HTML
    let html = '';

    // Render intention sections (in order)
    for (const intention of intentions) {
      const items = intentionTabs[intention.id];
      if (!items || items.length === 0) continue;

      html += `
        <div class="intention-section" data-intention-id="${intention.id}">
          <div class="section-header intention-header">
            <h2>${intention.emoji} ${intention.label}</h2>
            <div class="section-line"></div>
            <div class="section-count">${items.length} item${items.length !== 1 ? 's' : ''}</div>
          </div>
          <div class="deferred-list">
            ${items.map(item => renderDeferredItem(item, intentions)).join('')}
          </div>
        </div>`;
    }

    // Render general "Saved for Later" section
    if (generalTabs.length > 0) {
      html += `
        <div class="intention-section" data-intention-id="">
          <div class="section-header">
            <h2>Saved for later</h2>
            <div class="section-line"></div>
            <div class="section-count">${generalTabs.length} item${generalTabs.length !== 1 ? 's' : ''}</div>
          </div>
          <div class="deferred-list">
            ${generalTabs.map(item => renderDeferredItem(item, intentions)).join('')}
          </div>
        </div>`;
    }

    // Empty state (no active items at all)
    if (active.length === 0) {
      html += `
        <div class="section-header">
          <h2>Saved for later</h2>
          <div class="section-line"></div>
        </div>
        <div class="deferred-empty">Nothing saved. Living in the moment.</div>`;
    }

    // Archive section
    if (archived.length > 0) {
      html += `
        <div class="deferred-archive" id="deferredArchive">
          <button class="archive-toggle" id="archiveToggle">
            <svg class="archive-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            Archive
            <span class="archive-count" id="archiveCount">(${archived.length})</span>
          </button>
          <div class="archive-body" id="archiveBody" style="display:none">
            <input type="text" class="archive-search" id="archiveSearch" placeholder="Search archived tabs...">
            <div class="archive-list" id="archiveList">
              ${archived.map(item => renderArchiveItem(item)).join('')}
            </div>
          </div>
        </div>`;
    }

    // Settings button at the bottom
    html += `
      <div class="intention-settings-trigger">
        <button class="action-btn" data-action="open-intention-settings" style="font-size:11px;width:100%;justify-content:center;margin-top:12px;">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
          Edit categories
        </button>
      </div>`;

    // Replace column inner HTML (keep the column wrapper)
    column.innerHTML = html;

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item, intentions)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, intention tag, dismiss button.
 */
function renderDeferredItem(item, intentions = []) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  // Current intention tag (if any)
  const currentIntention = intentions.find(i => i.id === item.intentionId);
  const intentionTag = currentIntention
    ? `<span class="intention-tag" data-action="toggle-intention-picker" data-deferred-id="${item.id}" title="Change category">${currentIntention.emoji} ${currentIntention.label}</span>`
    : `<span class="intention-tag intention-tag-empty" data-action="toggle-intention-picker" data-deferred-id="${item.id}" title="Assign category">+ tag</span>`;

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
          ${intentionTag}
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards into collapsible open-tabs section ---
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  const openTabsToggleCount = document.getElementById('openTabsToggleCount');
  const openTabsCollapsible = document.getElementById('openTabsCollapsible');

  if (domainGroups.length > 0 && openTabsMissionsEl) {
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    if (openTabsToggleCount) {
      openTabsToggleCount.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} · ${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;
    }
    if (openTabsCollapsible) openTabsCollapsible.style.display = 'block';
  } else if (openTabsCollapsible) {
    openTabsCollapsible.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Next Up tabs ---
  checkTabOutDupes();
}

async function renderDashboard() {
  await renderStaticDashboard();
  await renderVisualCards();
  await renderIntentionNav();
}

// Active intention filter — null means "All"
let activeIntentionFilter = null;

/* ----------------------------------------------------------------
   VISUAL CARDS — Rich action cards in the left column
   ---------------------------------------------------------------- */

/**
 * renderVisualCards(filter)
 *
 * Renders saved tabs as visual cards in the left column.
 * If a filter is set, only shows cards matching that intentionId.
 */
async function renderVisualCards(filter) {
  if (filter !== undefined) activeIntentionFilter = filter;

  const grid      = document.getElementById('cardsGrid');
  const emptyEl   = document.getElementById('cardsEmpty');
  if (!grid) return;

  const { active } = await getSavedTabs();
  const intentions = await getIntentions();

  // Apply filter
  // Sort newest first
  active.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  const filtered = activeIntentionFilter === null
    ? active
    : activeIntentionFilter === ''
      ? active.filter(t => !t.intentionId)  // "Unsorted"
      : active.filter(t => t.intentionId === activeIntentionFilter);

  if (active.length === 0) {
    grid.style.display = 'none';
    emptyEl.style.display = 'flex';
    return;
  }

  emptyEl.style.display = 'none';
  grid.style.display = 'grid';

  grid.innerHTML = filtered.map(item => {
    const intention = intentions.find(i => i.id === item.intentionId);
    const intentionBadge = intention
      ? `<span class="vcard-intention">${intention.emoji} ${intention.label}</span>`
      : '';

    let domain = '';
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    const ago = timeAgo(item.savedAt);

    // Screenshot or fallback
    const imageHtml = item.screenshot
      ? `<div class="vcard-image"><img src="${item.screenshot}" alt="" loading="lazy"></div>`
      : `<div class="vcard-image vcard-image-placeholder">
           ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:24px;height:24px;opacity:0.4">` : ''}
         </div>`;

    // Action step or page title
    const mainTitle = item.actionStep || item.title || item.url;

    return `
      <div class="vcard" data-card-id="${item.id}" data-action="open-editor">
        ${imageHtml}
        <div class="vcard-body">
          <div class="vcard-step">${mainTitle}</div>
          <div class="vcard-meta">
            ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="vcard-favicon">` : ''}
            <span class="vcard-domain">${domain}</span>
            <span class="vcard-ago">${ago}</span>
            ${intentionBadge}
          </div>
        </div>
        <div class="vcard-actions">
          <a href="${item.url}" target="_blank" rel="noopener" class="vcard-open" title="Open">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
          </a>
          <button class="vcard-done" data-action="check-card" data-card-id="${item.id}" title="Done">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
          </button>
          <button class="vcard-dismiss" data-action="dismiss-card" data-card-id="${item.id}" title="Dismiss">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  // Show a "no cards in this filter" state
  if (filtered.length === 0 && active.length > 0) {
    const label = activeIntentionFilter === ''
      ? 'Unsorted'
      : intentions.find(i => i.id === activeIntentionFilter)?.label || '';
    grid.innerHTML = `<div class="cards-empty-filter">No cards in "${label}"</div>`;
  }
}


/* ----------------------------------------------------------------
   INTENTION NAV — Right sidebar filter
   ---------------------------------------------------------------- */

async function renderIntentionNav() {
  const navList = document.getElementById('intentionNavList');
  if (!navList) return;

  const intentions = await getIntentions();
  const { active } = await getSavedTabs();

  // Count per intention
  const counts = {};
  let unsortedCount = 0;
  for (const item of active) {
    if (item.intentionId) {
      counts[item.intentionId] = (counts[item.intentionId] || 0) + 1;
    } else {
      unsortedCount++;
    }
  }

  let html = '';

  // "All" filter
  const allActive = activeIntentionFilter === null ? ' active' : '';
  html += `<button class="intention-nav-item${allActive}" data-action="filter-intention" data-filter-id="__all__">
    <span class="intention-nav-label">All</span>
    <span class="intention-nav-count">${active.length}</span>
  </button>`;

  // Each intention
  for (const i of intentions) {
    const count = counts[i.id] || 0;
    const isActive = activeIntentionFilter === i.id ? ' active' : '';
    html += `<button class="intention-nav-item${isActive}" data-action="filter-intention" data-filter-id="${i.id}">
      <span class="intention-nav-emoji">${i.emoji}</span>
      <span class="intention-nav-label">${i.label}</span>
      <span class="intention-nav-count">${count}</span>
    </button>`;
  }

  // "Unsorted"
  if (unsortedCount > 0) {
    const unsortedActive = activeIntentionFilter === '' ? ' active' : '';
    html += `<button class="intention-nav-item${unsortedActive}" data-action="filter-intention" data-filter-id="__unsorted__">
      <span class="intention-nav-label" style="color:var(--muted)">Unsorted</span>
      <span class="intention-nav-count">${unsortedCount}</span>
    </button>`;
  }

  navList.innerHTML = html;
}


/* ----------------------------------------------------------------
   GLOBAL INTENTION PICKER — shared floating panel
   ---------------------------------------------------------------- */

/**
 * showGlobalPicker(triggerEl, opts)
 *
 * Positions the global picker next to the trigger element and
 * populates it with intention options.
 * opts.mode = 'open-tab' | 'saved-tab'
 * opts.tabUrl, opts.tabTitle — for open-tab mode
 * opts.deferredId — for saved-tab mode
 */
async function showGlobalPicker(triggerEl, opts) {
  const picker = document.getElementById('globalIntentionPicker');
  if (!picker) return;

  // Store context on the picker element
  picker.dataset.mode       = opts.mode;
  picker.dataset.tabUrl     = opts.tabUrl || '';
  picker.dataset.tabTitle   = opts.tabTitle || '';
  picker.dataset.deferredId = opts.deferredId || '';

  // Populate options
  await populateGlobalPickerOptions(opts.mode, opts.deferredId);

  // Position near the trigger
  const rect = triggerEl.getBoundingClientRect();
  picker.style.display = 'block';

  // Default: below the trigger, aligned left
  let top  = rect.bottom + 6;
  let left = rect.left;

  // If it would overflow right edge, align to right
  const pickerWidth = picker.offsetWidth || 220;
  if (left + pickerWidth > window.innerWidth - 16) {
    left = window.innerWidth - pickerWidth - 16;
  }

  // If it would overflow bottom, show above
  const pickerHeight = picker.offsetHeight || 200;
  if (top + pickerHeight > window.innerHeight - 16) {
    top = rect.top - pickerHeight - 6;
  }

  picker.style.top  = `${top}px`;
  picker.style.left = `${left}px`;

  // Focus the new-tag input for quick typing
  setTimeout(() => {
    const labelInput = document.getElementById('globalPickerNewLabel');
    if (labelInput) labelInput.focus();
  }, 50);
}

function hideGlobalPicker() {
  const picker = document.getElementById('globalIntentionPicker');
  if (picker) picker.style.display = 'none';
}

/**
 * populateGlobalPickerOptions(mode, deferredId)
 *
 * Fills the picker with current intentions as clickable options.
 */
async function populateGlobalPickerOptions(mode, deferredId) {
  const optionsEl = document.getElementById('globalPickerOptions');
  if (!optionsEl) return;

  const intentions = await getIntentions();

  // For saved-tab mode, find the current intentionId
  let currentIntentionId = null;
  if (mode === 'saved-tab' && deferredId) {
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const item = deferred.find(t => t.id === deferredId);
    if (item) currentIntentionId = item.intentionId;
  }

  let html = intentions.map(i => {
    const selected = currentIntentionId === i.id ? ' selected' : '';
    return `<div class="intention-option${selected}" data-action="pick-intention" data-intention-id="${i.id}">${i.emoji} ${i.label}</div>`;
  }).join('');

  // "Save without tag" option for open-tab mode
  if (mode === 'open-tab') {
    html += `<div class="intention-option intention-option-clear" data-action="pick-intention" data-intention-id="">📥 Save without tag</div>`;
  }

  // "Remove tag" for saved-tab mode with existing tag
  if (mode === 'saved-tab' && currentIntentionId) {
    html += `<div class="intention-option intention-option-clear" data-action="pick-intention" data-intention-id="">✕ Remove tag</div>`;
  }

  optionsEl.innerHTML = html;
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Next Up tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Next Up tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Open card editor ----
  if (action === 'open-editor') {
    // Don't open editor if clicking on action buttons inside the card
    if (e.target.closest('.vcard-actions') || e.target.closest('.vcard-open')) return;
    const cardId = actionEl.dataset.cardId;
    if (cardId) await openEditor(cardId);
    return;
  }

  // ---- Filter by intention (right nav) ----
  if (action === 'filter-intention') {
    const filterId = actionEl.dataset.filterId;
    if (filterId === '__all__') {
      await renderVisualCards(null);
    } else if (filterId === '__unsorted__') {
      await renderVisualCards('');
    } else {
      await renderVisualCards(filterId);
    }
    await renderIntentionNav();
    return;
  }

  // ---- Mark a visual card as done ----
  if (action === 'check-card') {
    e.stopPropagation();
    const cardId = actionEl.dataset.cardId;
    if (!cardId) return;
    await checkOffSavedTab(cardId);
    const card = actionEl.closest('.vcard');
    if (card) {
      const rect = card.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
      setTimeout(async () => {
        await renderVisualCards();
        await renderIntentionNav();
      }, 300);
    }
    playCloseSound();
    showToast('Done!');
    return;
  }

  // ---- Dismiss a visual card ----
  if (action === 'dismiss-card') {
    e.stopPropagation();
    const cardId = actionEl.dataset.cardId;
    if (!cardId) return;
    await dismissSavedTab(cardId);
    const card = actionEl.closest('.vcard');
    if (card) {
      card.style.transition = 'opacity 0.2s, transform 0.2s';
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(async () => {
        await renderVisualCards();
        await renderIntentionNav();
      }, 200);
    }
    showToast('Dismissed');
    return;
  }

  // ---- Open intention picker from a LEFT-column chip (open tab) ----
  if (action === 'open-chip-intention-picker') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    await showGlobalPicker(actionEl, {
      mode: 'open-tab',      // saving a currently-open tab
      tabUrl,
      tabTitle,
    });
    return;
  }

  // ---- Toggle intention picker on a RIGHT-column saved tab ----
  if (action === 'toggle-intention-picker') {
    e.stopPropagation();
    const deferredId = actionEl.dataset.deferredId;
    if (!deferredId) return;

    await showGlobalPicker(actionEl, {
      mode: 'saved-tab',     // re-tagging an already-saved tab
      deferredId,
    });
    return;
  }

  // ---- Pick an intention from the global picker ----
  if (action === 'pick-intention') {
    e.stopPropagation();
    const picker = document.getElementById('globalIntentionPicker');
    const intentionId = actionEl.dataset.intentionId || null;
    const mode       = picker?.dataset.mode;
    const tabUrl     = picker?.dataset.tabUrl;
    const tabTitle   = picker?.dataset.tabTitle;
    const deferredId = picker?.dataset.deferredId;

    hideGlobalPicker();

    if (mode === 'open-tab' && tabUrl) {
      // Save the open tab with the chosen intention, then close it
      await saveTabForLater({ url: tabUrl, title: tabTitle }, intentionId);
      const allTabs = await chrome.tabs.query({});
      const match = allTabs.find(t => t.url === tabUrl);
      if (match) await chrome.tabs.remove(match.id);
      await fetchOpenTabs();

      // Animate chip out
      const chip = Array.from(document.querySelectorAll('.page-chip[data-tab-url]')).find(el => el.dataset.tabUrl === tabUrl);
      if (chip) {
        const rect = chip.getBoundingClientRect();
        shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
        chip.style.transition = 'opacity 0.2s, transform 0.2s';
        chip.style.opacity = '0';
        chip.style.transform = 'scale(0.8)';
        setTimeout(() => {
          chip.remove();
          document.querySelectorAll('.mission-card').forEach(c => {
            if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
              animateCardOut(c);
            }
          });
        }, 200);
      }

      playCloseSound();
      const statTabs = document.getElementById('statTabs');
      if (statTabs) statTabs.textContent = openTabs.length;
      await renderDeferredColumn();

      const intention = (await getIntentions()).find(i => i.id === intentionId);
      showToast(intention ? `Saved to ${intention.emoji} ${intention.label}` : 'Saved for later');
    } else if (mode === 'saved-tab' && deferredId) {
      // Re-tag an existing saved tab
      await setTabIntention(deferredId, intentionId);
      await renderDeferredColumn();
      showToast(intentionId ? 'Category updated' : 'Category removed');
    }
    return;
  }

  // ---- Add new intention from inline picker input ----
  if (action === 'picker-add-intention') {
    e.stopPropagation();
    const emojiInput = document.getElementById('globalPickerNewEmoji');
    const labelInput = document.getElementById('globalPickerNewLabel');
    const emoji = (emojiInput?.value || '📌').trim();
    const label = (labelInput?.value || '').trim();
    if (!label) { showToast('Enter a tag name'); return; }

    const intentions = await addIntention({ label, emoji });
    if (emojiInput) emojiInput.value = '';
    if (labelInput) labelInput.value = '';

    // Re-render picker options with the new tag
    const picker = document.getElementById('globalIntentionPicker');
    if (picker) {
      await populateGlobalPickerOptions(picker.dataset.mode, picker.dataset.deferredId);
    }
    showToast(`Added "${emoji} ${label}"`);
    return;
  }

  // ---- Open intention settings modal ----
  if (action === 'open-intention-settings') {
    const modal = document.getElementById('intentionModal');
    if (modal) {
      modal.style.display = 'flex';
      await renderIntentionSettings();
    }
    return;
  }

  // ---- Close intention settings modal ----
  if (action === 'close-intention-modal') {
    const modal = document.getElementById('intentionModal');
    if (modal) modal.style.display = 'none';
    await renderDeferredColumn(); // refresh after edits
    return;
  }

  // ---- Add a new intention ----
  if (action === 'add-intention') {
    const emojiInput = document.getElementById('newIntentionEmoji');
    const labelInput = document.getElementById('newIntentionLabel');
    const emoji = (emojiInput?.value || '📌').trim();
    const label = (labelInput?.value || '').trim();
    if (!label) { showToast('Please enter a name'); return; }

    await addIntention({ label, emoji });
    if (emojiInput) emojiInput.value = '';
    if (labelInput) labelInput.value = '';
    await renderIntentionSettings();
    showToast(`Added "${label}"`);
    return;
  }

  // ---- Remove an intention ----
  if (action === 'remove-intention') {
    const id = actionEl.dataset.intentionId;
    if (!id) return;
    await removeIntention(id);
    await renderIntentionSettings();
    showToast('Category removed');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Open tabs toggle — expand/collapse ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#openTabsToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('openTabsBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Close global intention picker when clicking outside ----
document.addEventListener('click', (e) => {
  const picker = document.getElementById('globalIntentionPicker');
  if (!picker || picker.style.display === 'none') return;
  // Don't close if clicking inside the picker or on a trigger button
  if (e.target.closest('#globalIntentionPicker')) return;
  if (e.target.closest('[data-action="open-chip-intention-picker"]')) return;
  if (e.target.closest('[data-action="toggle-intention-picker"]')) return;
  hideGlobalPicker();
});

// ---- Close modal on overlay click ----
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.style.display = 'none';
    renderDeferredColumn();
  }
});

/**
 * renderIntentionSettings()
 *
 * Renders the editable list of intentions inside the settings modal.
 */
async function renderIntentionSettings() {
  const listEl = document.getElementById('intentionListEdit');
  if (!listEl) return;

  const intentions = await getIntentions();

  if (intentions.length === 0) {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px 0">No categories yet. Add one below.</div>';
    return;
  }

  listEl.innerHTML = intentions.map(i => `
    <div class="intention-edit-row">
      <span class="intention-edit-emoji">${i.emoji}</span>
      <span class="intention-edit-label">${i.label}</span>
      <button class="deferred-dismiss" data-action="remove-intention" data-intention-id="${i.id}" title="Remove">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  `).join('');
}

// ---- Enter key in picker's new-tag input triggers add ----
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'globalPickerNewLabel') {
    e.preventDefault();
    const addBtn = document.querySelector('[data-action="picker-add-intention"]');
    if (addBtn) addBtn.click();
  }
  // Escape closes picker
  if (e.key === 'Escape') {
    hideGlobalPicker();
    const modal = document.getElementById('intentionModal');
    if (modal && modal.style.display !== 'none') modal.style.display = 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   CARD EDITOR — Markdown editor with live preview
   ---------------------------------------------------------------- */

let editorCardId = null;
let editorAutoSaveTimer = null;

/**
 * openEditor(cardId)
 *
 * Opens the WYSIWYG editor for a saved card.
 */
async function openEditor(cardId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const card = deferred.find(t => t.id === cardId);
  if (!card) return;

  editorCardId = cardId;

  const overlay     = document.getElementById('editorOverlay');
  const titleEl     = document.getElementById('editorTitle');
  const urlEl       = document.getElementById('editorUrl');
  const faviconEl   = document.getElementById('editorFavicon');
  const domainEl    = document.getElementById('editorDomain');
  const agoEl       = document.getElementById('editorAgo');
  const intentionEl = document.getElementById('editorIntention');
  const contentEl   = document.getElementById('editorContent');
  const saveStatus  = document.getElementById('editorSaveStatus');

  // Title
  titleEl.textContent = card.actionStep || card.title || '';

  // Intention badge
  const intentions = await getIntentions();
  const intention = intentions.find(i => i.id === card.intentionId);
  intentionEl.textContent = intention ? `${intention.emoji} ${intention.label}` : '';
  intentionEl.style.display = intention ? 'inline-block' : 'none';

  // URL + favicon
  let domain = '';
  if (card.url) {
    try { domain = new URL(card.url).hostname.replace(/^www\./, ''); } catch {}
    urlEl.textContent = domain || card.url;
    urlEl.href = card.url;
    urlEl.style.display = 'inline';
    faviconEl.src = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    faviconEl.style.display = domain ? 'inline' : 'none';
    domainEl.textContent = domain;
  } else {
    urlEl.style.display = 'none';
    faviconEl.style.display = 'none';
    domainEl.textContent = '';
  }
  agoEl.textContent = timeAgo(card.savedAt);
  saveStatus.textContent = '';

  // Build HTML content — screenshot first, then notes
  let html = '';
  if (card.screenshot) {
    html += `<img src="${card.screenshot}" alt="screenshot"><br>`;
  }
  if (card.notes) {
    // If notes look like HTML (from previous WYSIWYG save), use directly
    if (card.notes.trim().startsWith('<')) {
      html += card.notes;
    } else {
      // Legacy markdown → convert to HTML
      html += marked.parse(card.notes, { breaks: true, gfm: true });
    }
  }
  contentEl.innerHTML = html;

  // Enable checkboxes
  contentEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.removeAttribute('disabled');
  });

  overlay.style.display = 'flex';
  setTimeout(() => contentEl.focus(), 100);
}

async function closeEditor() {
  await saveEditorNow();
  document.getElementById('editorOverlay').style.display = 'none';
  editorCardId = null;
  if (editorAutoSaveTimer) clearTimeout(editorAutoSaveTimer);
  // Disable animations so cards don't fade-in again after editing
  document.body.classList.add('no-animate');
  await renderVisualCards();
  // Keep no-animate long enough for browser to finish layout, then remove
  setTimeout(() => document.body.classList.remove('no-animate'), 500);
}

async function saveEditorNow() {
  if (!editorCardId) return;
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const card = deferred.find(t => t.id === editorCardId);
  if (!card) return;

  const contentEl = document.getElementById('editorContent');
  const titleEl   = document.getElementById('editorTitle');

  // Store HTML content (strip the screenshot img — it's stored separately)
  let html = contentEl.innerHTML;
  // Remove the leading screenshot img if it matches the stored one
  if (card.screenshot) {
    const div = document.createElement('div');
    div.innerHTML = html;
    const firstImg = div.querySelector('img');
    if (firstImg && firstImg.src === card.screenshot) {
      firstImg.remove();
      // Also remove trailing <br> after screenshot
      if (div.firstChild && div.firstChild.nodeName === 'BR') div.firstChild.remove();
    }
    html = div.innerHTML;
  }
  card.notes = html;

  const newTitle = titleEl.textContent.trim();
  if (newTitle) {
    card.actionStep = newTitle;
    card.title = newTitle;
  }

  await chrome.storage.local.set({ deferred });

  const saveStatus = document.getElementById('editorSaveStatus');
  if (saveStatus) {
    saveStatus.textContent = 'Saved';
    setTimeout(() => { if (saveStatus) saveStatus.textContent = ''; }, 1500);
  }
}

function scheduleAutoSave() {
  if (editorAutoSaveTimer) clearTimeout(editorAutoSaveTimer);
  editorAutoSaveTimer = setTimeout(saveEditorNow, 1000);
}

// ── Editor event listeners ──

// Close
document.addEventListener('click', (e) => {
  if (e.target.closest('#editorClose')) { closeEditor(); return; }
  if (e.target.id === 'editorOverlay') { closeEditor(); return; }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editorCardId) {
    const pasteModal = document.getElementById('pasteCardModal');
    const intentionModal = document.getElementById('intentionModal');
    if (pasteModal?.style.display !== 'none' && pasteModal?.style.display) return;
    if (intentionModal?.style.display !== 'none' && intentionModal?.style.display) return;
    closeEditor();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && editorCardId) {
    e.preventDefault();
    saveEditorNow();
  }
});

// Auto-save on content changes
document.addEventListener('input', (e) => {
  if (e.target.id === 'editorContent' || e.target.id === 'editorTitle') {
    scheduleAutoSave();
  }
});

// Keyboard shortcuts inside WYSIWYG
document.addEventListener('keydown', (e) => {
  const contentEl = document.getElementById('editorContent');
  if (!contentEl || document.activeElement !== contentEl) return;

  // Cmd+B → bold
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
    e.preventDefault();
    document.execCommand('bold');
    scheduleAutoSave();
    return;
  }
  // Cmd+I → italic
  if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
    e.preventDefault();
    document.execCommand('italic');
    scheduleAutoSave();
    return;
  }
  // Cmd+K → insert link
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const url = prompt('URL:');
    if (url) document.execCommand('createLink', false, url);
    scheduleAutoSave();
    return;
  }
});

/**
 * Markdown-style shortcuts: detect pattern after Space key press.
 * We listen on keydown for Space, check what's before the cursor,
 * and convert if it matches a markdown pattern.
 */
document.addEventListener('keydown', (e) => {
  const contentEl = document.getElementById('editorContent');
  if (!contentEl || document.activeElement !== contentEl) return;
  if (e.key !== ' ') return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;

  // Get text before cursor in this text node
  const textBefore = node.textContent.slice(0, sel.anchorOffset);

  // Find the block-level parent (div, p, or the contenteditable itself)
  const getBlock = () => {
    let el = node.parentElement;
    while (el && el !== contentEl && !['DIV','P','LI'].includes(el.tagName)) {
      el = el.parentElement;
    }
    return el === contentEl ? null : el;
  };

  const replaceBlock = (newEl) => {
    e.preventDefault();
    const block = getBlock();
    if (block) {
      block.replaceWith(newEl);
    } else {
      node.remove();
      contentEl.appendChild(newEl);
    }
    const range = document.createRange();
    range.setStart(newEl.lastChild || newEl, newEl.lastChild ? 0 : 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleAutoSave();
  };

  // `## ` → H2
  if (textBefore === '##') {
    const h2 = document.createElement('h2');
    h2.appendChild(document.createElement('br'));
    replaceBlock(h2);
    return;
  }

  // `# ` → H1
  if (textBefore === '#') {
    const h1 = document.createElement('h1');
    h1.appendChild(document.createElement('br'));
    replaceBlock(h1);
    return;
  }

  // `### ` → H3
  if (textBefore === '###') {
    const h3 = document.createElement('h3');
    h3.appendChild(document.createElement('br'));
    replaceBlock(h3);
    return;
  }

  // `- ` → bullet list
  if (textBefore === '-') {
    e.preventDefault();
    const block = getBlock();
    const ul = document.createElement('ul');
    const li = document.createElement('li');
    li.appendChild(document.createElement('br'));
    ul.appendChild(li);
    if (block) { block.replaceWith(ul); } else { node.remove(); contentEl.appendChild(ul); }
    const range = document.createRange();
    range.setStart(li, 0);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleAutoSave();
    return;
  }

  // `[]` or `[ ]` → checkbox
  if (textBefore === '[]' || textBefore === '[ ]') {
    e.preventDefault();
    const block = getBlock();
    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const span = document.createElement('span');
    span.appendChild(document.createElement('br'));
    wrapper.appendChild(cb);
    wrapper.appendChild(span);
    if (block) { block.replaceWith(wrapper); } else { node.remove(); contentEl.appendChild(wrapper); }
    const range = document.createRange();
    range.setStart(span, 0);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleAutoSave();
    return;
  }

  // `> ` → blockquote
  if (textBefore === '>') {
    const bq = document.createElement('blockquote');
    bq.appendChild(document.createElement('br'));
    replaceBlock(bq);
    return;
  }

  // `1.` → ordered list
  if (textBefore === '1.') {
    e.preventDefault();
    const block = getBlock();
    const ol = document.createElement('ol');
    const li = document.createElement('li');
    li.appendChild(document.createElement('br'));
    ol.appendChild(li);
    if (block) { block.replaceWith(ol); } else { node.remove(); contentEl.appendChild(ol); }
    const range = document.createRange();
    range.setStart(li, 0);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleAutoSave();
    return;
  }
});

// `---` + Enter → hr
document.addEventListener('keydown', (e) => {
  const contentEl = document.getElementById('editorContent');
  if (!contentEl || document.activeElement !== contentEl) return;
  if (e.key !== 'Enter') return;

  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  if (!node) return;

  const text = (node.nodeType === Node.TEXT_NODE) ? node.textContent.trim() : '';
  if (text === '---' || text === '***') {
    e.preventDefault();
    const block = node.parentElement === contentEl ? node : node.parentElement;
    const hr = document.createElement('hr');
    const p = document.createElement('div');
    p.appendChild(document.createElement('br'));
    block.replaceWith ? block.replaceWith(hr) : contentEl.appendChild(hr);
    hr.after(p);
    const range = document.createRange();
    range.setStart(p, 0);
    sel.removeAllRanges();
    sel.addRange(range);
    scheduleAutoSave();
  }
});

// Paste images into WYSIWYG
document.addEventListener('paste', (e) => {
  const contentEl = document.getElementById('editorContent');
  if (!contentEl || !contentEl.contains(document.activeElement) && document.activeElement !== contentEl) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;

      const reader = new FileReader();
      reader.onloadend = () => {
        const img = document.createElement('img');
        img.src = reader.result;
        img.alt = 'image';

        const sel = window.getSelection();
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(img);
          range.setStartAfter(img);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          contentEl.appendChild(img);
        }
        scheduleAutoSave();
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});


/* ----------------------------------------------------------------
   PASTE IMAGE → NEW CARD
   Cmd+V with an image in clipboard opens the paste-card modal.
   ---------------------------------------------------------------- */

let pasteImageData = null;
let pasteSelectedIntention = null;

document.addEventListener('paste', async (e) => {
  // Only handle if no input/textarea is focused
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;

      // Convert to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        pasteImageData = reader.result;
        pasteSelectedIntention = null;
        await openPasteModal(pasteImageData);
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

async function openPasteModal(imageDataUrl) {
  const modal = document.getElementById('pasteCardModal');
  const img   = document.getElementById('pastePreviewImg');
  const input = document.getElementById('pasteActionStep');
  const urlInput = document.getElementById('pasteUrl');
  if (!modal) return;

  img.src = imageDataUrl;
  input.value = '';
  urlInput.value = '';
  pasteSelectedIntention = null;

  // Render intention chips
  const intentions = await getIntentions();
  const container = document.getElementById('pasteIntentions');
  container.innerHTML = intentions.map(i =>
    `<button class="paste-intention-chip" data-intention-id="${i.id}">${i.emoji} ${i.label}</button>`
  ).join('') +
  `<button class="paste-intention-chip paste-intention-none active" data-intention-id="">No intention</button>`;

  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

// Intention chip clicks inside paste modal
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.paste-intention-chip');
  if (!chip) return;
  e.stopPropagation();

  // Toggle active
  document.querySelectorAll('.paste-intention-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  pasteSelectedIntention = chip.dataset.intentionId || null;
});

// Close paste modal
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action="close-paste-modal"]')) {
    document.getElementById('pasteCardModal').style.display = 'none';
    pasteImageData = null;
    return;
  }
  if (e.target.id === 'pasteCardModal') {
    e.target.style.display = 'none';
    pasteImageData = null;
    return;
  }
  if (e.target.id === 'pasteRemoveImg') {
    pasteImageData = null;
    document.getElementById('pastePreviewImg').src = '';
    document.querySelector('.paste-preview').style.display = 'none';
    return;
  }
});

// Save paste card
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'pasteSaveBtn') return;

  const actionStep = document.getElementById('pasteActionStep').value.trim();
  const url = document.getElementById('pasteUrl').value.trim();

  if (!pasteImageData && !actionStep) {
    showToast('Add an image or action step');
    return;
  }

  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:           Date.now().toString(),
    url:          url || '',
    title:        actionStep || 'Pasted card',
    actionStep:   actionStep,
    screenshot:   pasteImageData,
    savedAt:      new Date().toISOString(),
    completed:    false,
    dismissed:    false,
    intentionId:  pasteSelectedIntention || null,
  });
  await chrome.storage.local.set({ deferred });

  // Close modal and refresh
  document.getElementById('pasteCardModal').style.display = 'none';
  pasteImageData = null;
  playCloseSound();
  showToast('Card created');
  await renderVisualCards();
  await renderIntentionNav();
});

// Add new intention from paste modal
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'pasteAddIntentionBtn') return;
  const emojiInput = document.getElementById('pasteNewEmoji');
  const labelInput = document.getElementById('pasteNewLabel');
  const emoji = (emojiInput?.value || '📌').trim();
  const label = (labelInput?.value || '').trim();
  if (!label) { showToast('Enter a name'); return; }

  const result = await addIntention({ label, emoji });
  if (emojiInput) emojiInput.value = '';
  if (labelInput) labelInput.value = '';

  // Re-render intention chips and auto-select the new one
  const intentions = await getIntentions();
  const container = document.getElementById('pasteIntentions');
  container.innerHTML = intentions.map(i =>
    `<button class="paste-intention-chip${i.id === result[result.length - 1].id ? ' active' : ''}" data-intention-id="${i.id}">${i.emoji} ${i.label}</button>`
  ).join('') +
  `<button class="paste-intention-chip paste-intention-none" data-intention-id="">No intention</button>`;
  pasteSelectedIntention = result[result.length - 1].id;
  showToast(`Added "${emoji} ${label}"`);
});

// Enter in paste modal new-intention input
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'pasteNewLabel') {
    e.preventDefault();
    document.getElementById('pasteAddIntentionBtn')?.click();
    return;
  }
});

// Enter in action step input triggers save
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'pasteActionStep') {
    const modal = document.getElementById('pasteCardModal');
    if (modal && modal.style.display !== 'none') {
      e.preventDefault();
      document.getElementById('pasteSaveBtn').click();
    }
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
