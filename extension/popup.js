/* popup.js — Tab Out: Capture → Action Step → Intention → Save
 *
 * Flow:
 * 1. Show current tab info
 * 2. User clicks "Capture region" → popup closes, overlay injected
 * 3. User drags region → background crops screenshot → stores in storage
 * 4. User re-opens popup → screenshot shown, fill action step, pick intention
 * 5. Save: stores card in chrome.storage.local 'deferred', closes tab
 */

'use strict';

const DEFAULT_INTENTIONS = [
  { id: 'practice',   label: 'To Practice',   emoji: '🔧', order: 0 },
  { id: 'read-later', label: 'Read Later',    emoji: '📖', order: 1 },
  { id: 'deep-dive',  label: 'Deep Dive',     emoji: '🧘', order: 2 },
  { id: 'casual',     label: 'Just Browsing',  emoji: '👀', order: 3 },
];

let currentTab = null;
let pendingScreenshot = null;

/* ── Storage helpers ─────────────────────────────────────────────── */

async function getIntentions() {
  const { intentions } = await chrome.storage.local.get('intentions');
  if (!intentions || intentions.length === 0) {
    await chrome.storage.local.set({ intentions: DEFAULT_INTENTIONS });
    return DEFAULT_INTENTIONS;
  }
  return intentions.sort((a, b) => a.order - b.order);
}

async function saveDeferred(tab, intentionId, actionStep, screenshot) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:           Date.now().toString(),
    url:          tab.url,
    title:        tab.title,
    actionStep:   actionStep || '',
    screenshot:   screenshot || null,
    savedAt:      new Date().toISOString(),
    completed:    false,
    dismissed:    false,
    intentionId:  intentionId || null,
  });
  await chrome.storage.local.set({ deferred });
  // Clean up pending screenshot
  await chrome.storage.local.remove('__pendingScreenshot');
}

async function addNewIntention(label, emoji) {
  const intentions = await getIntentions();
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (intentions.some(i => i.id === id)) return null;
  const order = intentions.length;
  const newItem = { id, label, emoji, order };
  intentions.push(newItem);
  await chrome.storage.local.set({ intentions });
  return newItem;
}

/* ── UI helpers ──────────────────────────────────────────────────── */

function renderIntentions(intentions) {
  const list = document.getElementById('intentions-list');
  list.innerHTML = '';
  intentions.forEach(intent => {
    const btn = document.createElement('button');
    btn.className = 'intention-btn';
    btn.innerHTML = `<span class="emoji">${intent.emoji}</span><span>${intent.label}</span>`;
    btn.addEventListener('click', () => handleSave(intent.id));
    list.appendChild(btn);
  });
}

function showScreenshot(dataUrl) {
  pendingScreenshot = dataUrl;
  const preview = document.getElementById('screenshot-preview');
  const img     = document.getElementById('screenshot-img');
  const btn     = document.getElementById('capture-btn');
  img.src = dataUrl;
  preview.style.display = 'block';
  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:18px;height:18px">
      <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
    </svg>
    Recapture`;
}

function hideScreenshot() {
  pendingScreenshot = null;
  const preview = document.getElementById('screenshot-preview');
  const btn     = document.getElementById('capture-btn');
  preview.style.display = 'none';
  btn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width:18px;height:18px">
      <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
    </svg>
    Capture region`;
  chrome.storage.local.remove('__pendingScreenshot');
}

/* ── Actions ─────────────────────────────────────────────────────── */

async function handleSave(intentionId) {
  if (!currentTab) return;
  const actionStep = document.getElementById('action-step').value.trim();
  await saveDeferred(currentTab, intentionId, actionStep, pendingScreenshot);

  // Close the saved tab
  try {
    await chrome.tabs.remove(currentTab.id);
  } catch (e) {
    // tab may already be closed — that's fine
  }
  window.close();
}

function startCapture() {
  // Tell background to inject the capture overlay into the active tab
  chrome.runtime.sendMessage({ action: 'start-capture' });
  // Close the popup so the user can interact with the page
  window.close();
}

/* ── Init ────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    currentTab = tabs[0];
    document.getElementById('tab-title').textContent = currentTab.title || currentTab.url;
    const favicon = document.getElementById('tab-favicon');
    if (currentTab.favIconUrl) {
      favicon.src = currentTab.favIconUrl;
    } else {
      favicon.style.display = 'none';
    }
  }

  // Check for a pending screenshot (from a previous capture)
  const { __pendingScreenshot } = await chrome.storage.local.get('__pendingScreenshot');
  if (__pendingScreenshot) {
    showScreenshot(__pendingScreenshot);
  }

  // Load and render intentions
  const intentions = await getIntentions();
  renderIntentions(intentions);

  // ── Capture button ──
  document.getElementById('capture-btn').addEventListener('click', startCapture);

  // ── Remove screenshot ──
  document.getElementById('screenshot-remove').addEventListener('click', hideScreenshot);

  // ── Save without intention ──
  document.getElementById('save-plain-btn').addEventListener('click', () => handleSave(null));

  // ── Add new intention ──
  const emojiInput = document.getElementById('new-emoji');
  const nameInput  = document.getElementById('new-name');
  const addBtn     = document.getElementById('add-tag-btn');

  function updateAddBtn() {
    // Only require name — emoji defaults to 📌 if empty
    addBtn.disabled = !nameInput.value.trim();
  }

  emojiInput.addEventListener('input', updateAddBtn);
  nameInput.addEventListener('input', updateAddBtn);

  addBtn.addEventListener('click', async () => {
    const label = nameInput.value.trim();
    const emoji = emojiInput.value.trim() || '📌';
    if (!label) return;

    const result = await addNewIntention(label, emoji);
    if (result) {
      const updated = await getIntentions();
      renderIntentions(updated);
      emojiInput.value = '';
      nameInput.value  = '';
      addBtn.disabled  = true;
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !addBtn.disabled) addBtn.click();
  });

  // ── Listen for screenshot-ready from background ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'screenshot-ready' && msg.screenshot) {
      showScreenshot(msg.screenshot);
    }
  });
});
