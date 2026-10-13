const $ = (id) => document.getElementById(id);
const LISTS = ['blocklist', 'metadataOnly'];

async function load() {
  const { settings, outbox = [] } = await chrome.storage.local.get(['settings', 'outbox']);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  $('paused').checked = !!s.paused;
  for (const k of LISTS) $(k).value = s[k].join('\n');

  const up = await fetch('http://127.0.0.1:47821/health', { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok).catch(() => false);
  const queued = outbox.length ? `, ${outbox.length} queued` : '';
  $('status').textContent = (up ? 'Server running' : 'Server NOT running') + queued;
}

const parseList = (text) => text.split('\n')
  .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
  .filter(Boolean);

async function save() {
  const settings = { paused: $('paused').checked };
  for (const k of LISTS) settings[k] = parseList($(k).value);
  await chrome.storage.local.set({ settings });
}

$('paused').addEventListener('change', save);
for (const k of LISTS) $(k).addEventListener('change', save);
load();
