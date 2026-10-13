// Browsing Journal service worker.
//
// A "visit" is one page you looked at with Chrome focused and the machine not idle. Focused
// segments on the same URL separated by less than MERGE_GAP_MS (e.g. an accidental cmd+tab)
// merge into one visit. Visits with under MIN_DWELL_MS of focused time are discarded and never
// leave the browser. Finished visits go to the local server; failed sends are retried.

const ENDPOINT = 'http://127.0.0.1:47821';
const MIN_DWELL_MS = 20_000;
const MERGE_GAP_MS = 20_000;
const IDLE_SEC = 300;
const MAX_CAPTURE_TRIES = 3;
const SHORT_TEXT = 400; // a first read shorter than this is probably a page still rendering
const OUTBOX_MAX = 300;

// Chrome runs this as a service worker and loads shared.js here; Safari lists both files in
// the manifest's background scripts, so importScripts doesn't exist there.
if (typeof importScripts === 'function') importScripts('shared.js'); // DEFAULT_SETTINGS, hostMatches, redactUrl

const BROWSER = typeof navigator !== 'undefined' && /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent)
  ? 'safari' : 'chrome';
// Safari has no idle API. There a content script reports keyboard and mouse activity instead.
const HAS_IDLE = typeof chrome.idle !== 'undefined';

// All state changes run one at a time, because events arrive in bursts.
let chain = Promise.resolve();
const run = (fn) => (chain = chain.then(fn).catch((e) => console.error(e)));

chrome.alarms.get('tick', (a) => {
  if (!a) chrome.alarms.create('tick', { periodInMinutes: 0.5 });
});

chrome.tabs.onActivated.addListener(() => run(reconcile));
chrome.tabs.onRemoved.addListener(() => run(reconcile));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.title || change.status === 'complete')) run(reconcile);
});
chrome.windows.onFocusChanged.addListener(() => run(reconcile));
if (HAS_IDLE) {
  chrome.idle.setDetectionInterval(IDLE_SEC);
  chrome.idle.onStateChanged.addListener(() => run(reconcile));
}
chrome.runtime.onMessage.addListener((msg) => {
  if (HAS_IDLE || !msg || !msg.activity) return;
  run(async () => {
    await chrome.storage.local.set({ lastActivity: Date.now() });
    await reconcile();
  });
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) run(reconcile);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') run(async () => { await reconcile(); await flushOutbox(); });
});
chrome.runtime.onStartup.addListener(() => run(async () => { await recover(); await reconcile(); }));
chrome.runtime.onInstalled.addListener(() => run(reconcile));

async function idleState() {
  if (HAS_IDLE) return chrome.idle.queryState(IDLE_SEC);
  const { lastActivity = 0 } = await chrome.storage.local.get('lastActivity');
  return Date.now() - lastActivity > IDLE_SEC * 1000 ? 'idle' : 'active';
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

function normalise(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// What should currently be counting as "being read", or null if nothing.
async function currentTarget(settings) {
  if (settings.paused) return null;
  const win = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win || !win.focused || win.type !== 'normal' || win.incognito) return null;
  if ((await idleState()) !== 'active') return null;
  const tab = win.tabs?.find((t) => t.active);
  const url = tab?.url && normalise(tab.url);
  if (!url || hostMatches(url, settings.blocklist)) return null;
  return { url, title: tab.title || '', tabId: tab.id, light: hostMatches(url, settings.metadataOnly) };
}

async function reconcile() {
  const now = Date.now();
  const settings = await getSettings();
  let { visit: v = null } = await chrome.storage.local.get('visit');
  const want = await currentTarget(settings);
  const finished = []; // visits that ended during this run, sent only once the new state is saved

  // Close the open segment if what's focused is no longer this visit.
  if (v && v.segStart !== null && (!want || want.url !== v.url)) {
    v.focusedMs += now - v.segStart;
    v.lastEnd = now;
    v.segStart = null;
  }

  if (want) {
    if (v && v.segStart !== null) {
      // Still on the same page: refresh the title and checkpoint for crash recovery.
      v.title = want.title || v.title;
      v.tabId = want.tabId;
      v.lastEnd = now;
    } else if (v && v.url === want.url && now - v.lastEnd < MERGE_GAP_MS) {
      v.segStart = now; // came straight back: continue the same visit
      v.title = want.title || v.title;
      v.tabId = want.tabId;
    } else {
      if (v) finished.push(v);
      v = { url: want.url, title: want.title, tabId: want.tabId, start: now, lastEnd: now,
            focusedMs: 0, segStart: now, text: '', tries: 0, refreshed: false, light: want.light };
    }
  } else if (v && v.segStart === null && now - v.lastEnd >= MERGE_GAP_MS) {
    finished.push(v);
    v = null;
  }

  // Read the page as soon as it has finished loading, not only once the visit qualifies: by the
  // time a 20 second visit ends, the tab has usually already moved on. The text stays in the
  // browser and is only sent if the visit is logged. Log-time-only sites are never read. A page
  // that was still rendering on the first read gets one more read once the visit qualifies.
  if (v && !v.light && v.tries < MAX_CAPTURE_TRIES) {
    const focused = v.focusedMs + (v.segStart === null ? 0 : now - v.segStart);
    const refresh = !!v.text && !v.refreshed && v.text.length < SHORT_TEXT && focused >= MIN_DWELL_MS;
    if (!v.text || refresh) {
      const text = await capture(v);
      if (text !== null) { // null means the page isn't ready yet, so try again on a later run
        v.tries += 1;
        if (refresh) v.refreshed = true;
        if (text.length > v.text.length) v.text = text;
      }
    }
  }

  // Save the new state first, then send what finished. If the save fails nothing is sent, so a
  // finished visit can't be re-sent on every later run. Never set() null: Safari rejects it.
  if (v) await chrome.storage.local.set({ visit: v });
  else await chrome.storage.local.remove('visit');
  await flushOutbox(finished.map(toEntry).filter(Boolean));
}

// The page text, '' if it can't be read, or null if the page is still loading.
async function capture(v) {
  const tab = await chrome.tabs.get(v.tabId).catch(() => null);
  if (!tab || normalise(tab.url) !== v.url) return ''; // tab closed or navigated away
  if (tab.status && tab.status !== 'complete') return null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: v.tabId }, func: readPage });
    return res?.result || '';
  } catch {
    return ''; // e.g. the Web Store, or a page that refuses injection
  }
}

// Runs inside the page. Skips pages with password, card or one-time-code fields so that
// sign-in and payment screens are never read.
function readPage() {
  const sensitive = 'input[type="password"], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]';
  if (document.querySelector(sensitive)) return '';
  const clean = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const main = clean(document.querySelector('article, main, [role="main"]'));
  return (main.length > 200 ? main : clean(document.body)).slice(0, 6000);
}

function toEntry(v) {
  if (v.focusedMs < MIN_DWELL_MS) return null;
  return {
    url: redactUrl(v.url),
    title: v.title,
    start: new Date(v.start).toISOString(),
    end: new Date(v.lastEnd).toISOString(),
    focused_s: Math.round(v.focusedMs / 1000),
    browser: BROWSER,
    text: v.text,
  };
}

async function flushOutbox(extra = []) {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  outbox.push(...extra);
  if (!outbox.length) return;
  let sent = 0;
  for (const entry of outbox) {
    try {
      const r = await fetch(`${ENDPOINT}/visit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status >= 500) break; // server trouble: keep it and retry later
    } catch {
      break; // server not running: keep it and retry later
    }
    sent += 1; // delivered, or rejected as invalid (4xx) and not worth retrying
  }
  await chrome.storage.local.set({ outbox: outbox.slice(sent).slice(-OUTBOX_MAX) });
}

// After a browser restart a stored open segment can't be trusted past its last checkpoint.
async function recover() {
  const { visit: v } = await chrome.storage.local.get('visit');
  if (v && v.segStart !== null) {
    v.focusedMs += Math.max(0, v.lastEnd - v.segStart);
    v.segStart = null;
    await chrome.storage.local.set({ visit: v });
  }
}
