import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const src = fs.readFileSync(process.argv[2], 'utf8');

function makeEnv(opts = {}) {
  const messageListeners = [];
  const ctl = { failVisitSet: false };
  const store = {};
  const sent = [];
  let now = 1_000_000;
  const st = { status: 'complete', pageText: null, focused: true, idle: 'active', url: 'https://a.com/', title: 'A', tabId: 1, closed: false };
  const chrome = {
    idle: { setDetectionInterval() {}, onStateChanged: { addListener() {} }, queryState: async () => st.idle },
    alarms: { get() {}, create() {}, onAlarm: { addListener() {} } },
    tabs: {
      onActivated: { addListener() {} }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => (st.closed ? Promise.reject(new Error('no tab')) : { id: st.tabId, url: st.url, status: st.status }),
    },
    windows: {
      onFocusChanged: { addListener() {} },
      getLastFocused: async () => ({ focused: st.focused, type: 'normal', incognito: false,
        tabs: [{ id: st.tabId, active: true, url: st.url, title: st.title }] }),
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = structuredClone(store[k]); return o; },
        set: async (o) => {
          // Safari's storage table is "value TEXT NOT NULL": a null value is rejected.
          if (opts.rejectNull && Object.values(o).some((x) => x === null || x === undefined)) throw new Error('NOT NULL constraint failed');
          if ('visit' in o && ctl.failVisitSet) { ctl.failVisitSet = false; throw new Error('storage unavailable'); }
          Object.assign(store, structuredClone(o));
        },
        remove: async (k) => {
          if ([].concat(k).includes('visit') && ctl.failVisitSet) { ctl.failVisitSet = false; throw new Error('storage unavailable'); }
          for (const key of [].concat(k)) delete store[key];
        },
      },
    },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener: (fn) => messageListeners.push(fn) } },
    scripting: { executeScript: async () => [{ result: `text of ${st.url}` }] },
  };
  if (opts.noIdle) delete chrome.idle; // Safari
  const ctx = vm.createContext({
    chrome,
    navigator: opts.ua ? { userAgent: opts.ua } : undefined, console, URL, structuredClone, Promise, AbortSignal,
    Date: class FakeDate extends Date { static now() { return now; } },
    fetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return { status: 204 }; },
    setTimeout,
  });
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(path.dirname(process.argv[2]), f), 'utf8'), ctx);
  let reads = 0;
  chrome.scripting.executeScript = async () => { reads++; return [{ result: st.pageText ?? `text of ${st.url}` }]; };
  ctx.reads = () => reads;
  vm.runInContext(src, ctx);
  const advance = (ms) => { now += ms; }; // time passes with no check running, as between 30s ticks
  const tick = async (ms) => { now += ms; await vm.runInContext('run(reconcile)', ctx); };
  const activity = async () => { messageListeners.forEach((fn) => fn({ activity: true })); await vm.runInContext('chain', ctx); };
  return { st, sent, tick, advance, activity, store, ctx, ctl, settings: (s) => { store.settings = s; } };
}

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failures++; };

// 1. under 20s then switch away: nothing logged
{ const e = makeEnv(); await e.tick(0); await e.tick(10_000); e.st.url = 'https://b.com/'; await e.tick(0); await e.tick(60_000);
  check('<20s page is dropped (and b.com too, never reaching 20s)', e.sent.length === 0, JSON.stringify(e.sent)); }

// 2. 30s then leave: logged once with ~30s and page text
{ const e = makeEnv(); await e.tick(0); await e.tick(30_000); e.st.focused = false; await e.tick(0); await e.tick(25_000); await e.tick(0);
  check('30s visit logged once', e.sent.length === 1, JSON.stringify(e.sent));
  check('focused_s = 30', e.sent[0]?.focused_s === 30, String(e.sent[0]?.focused_s));
  check('page text captured', e.sent[0]?.text === 'text of https://a.com/', e.sent[0]?.text); }

// 3. accidental cmd+tab: 15s, 5s away, 15s => merged, 30s focused (not 35)
{ const e = makeEnv(); await e.tick(0); await e.tick(15_000); e.st.focused = false; await e.tick(0); await e.tick(5_000);
  e.st.focused = true; await e.tick(0); await e.tick(15_000); e.st.url = 'https://b.com/'; await e.tick(0);
  check('merged across short blur => 1 visit', e.sent.length === 1, JSON.stringify(e.sent));
  check('only focused time counted (30s)', e.sent[0]?.focused_s === 30, String(e.sent[0]?.focused_s)); }

// 4. long absence: 15s, 60s away, 15s => two separate sub-threshold visits, none logged
{ const e = makeEnv(); await e.tick(0); await e.tick(15_000); e.st.focused = false; await e.tick(0); await e.tick(60_000); await e.tick(0);
  e.st.focused = true; await e.tick(0); await e.tick(15_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('long gap does not merge => nothing logged', e.sent.length === 0, JSON.stringify(e.sent)); }

// 5. idle time is not counted: 25s active, goes idle for 10 min
{ const e = makeEnv(); await e.tick(0); await e.tick(25_000); e.st.idle = 'idle'; await e.tick(0); await e.tick(600_000); await e.tick(0);
  check('idle stops the clock (25s)', e.sent.length === 1 && e.sent[0].focused_s === 25, JSON.stringify(e.sent.map(s => s.focused_s))); }

// 6. blocklist + pause
{ const e = makeEnv(); e.settings({ blocklist: ['a.com'] }); await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('blocklisted domain never logged or read', e.sent.length === 0); }
{ const e = makeEnv(); e.settings({ blocklist: ['notmatch.com'], paused: true }); await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('paused logs nothing', e.sent.length === 0); }

// 7. server down: outbox keeps it, later flush delivers
{ const e = makeEnv(); let down = true;
  e.ctx.fetch = async (_u, init) => { if (down) throw new Error('refused'); e.sent.push(JSON.parse(init.body)); return { status: 204 }; };
  await e.tick(0); await e.tick(30_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('queued while server down', e.sent.length === 0 && e.store.outbox?.length === 1);
  down = false; await vm.runInContext('run(flushOutbox)', e.ctx);
  check('delivered after server returns', e.sent.length === 1 && e.store.outbox.length === 0); }

// 8. default blocklist: gmail is never logged or read
{ const e = makeEnv(); e.st.url = 'https://mail.google.com/mail/u/0/'; await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('gmail ignored by default', e.sent.length === 0 && e.ctx.reads() === 0); }

// 9. metadata-only: logged with time, page never read, no text sent
{ const e = makeEnv(); e.st.url = 'https://www.youtube.com/watch?v=1'; await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('metadata-only site is logged', e.sent.length === 1 && e.sent[0].focused_s === 60, JSON.stringify(e.sent.map(s => s.focused_s)));
  check('metadata-only page is never read', e.ctx.reads() === 0 && !e.sent[0]?.text); }

// 10. subdomain matching, and a normal site is still read
{ const e = makeEnv(); e.st.url = 'https://docs.google.com/document/d/1'; await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('docs.google.com not caught by gmail/www.google.com rules', e.sent.length === 1 && e.sent[0].text === 'text of https://docs.google.com/document/d/1'); }

// 11. URL redaction
{ const e = makeEnv();
  const r = (u) => vm.runInContext('redactUrl(' + JSON.stringify(u) + ')', e.ctx);
  check('masks token/code/session params', r('https://x.com/cb?access_token=abc&code=123&ok=1&sessionid=zz') === 'https://x.com/cb?access_token=REDACTED&code=REDACTED&ok=1&sessionid=REDACTED', r('https://x.com/cb?access_token=abc&code=123&ok=1&sessionid=zz'));
  check('keeps ordinary params (q, v, author, keyword)', r('https://y.com/s?q=cats&v=abc&author=bob&keyword=shoes') === 'https://y.com/s?q=cats&v=abc&author=bob&keyword=shoes', r('https://y.com/s?q=cats&v=abc&author=bob&keyword=shoes'));
  check('strips user:pass@', r('https://bob:hunter2@host.com/p') === 'https://host.com/p', r('https://bob:hunter2@host.com/p'));
  check('url with no query is unchanged', r('https://z.com/a/b') === 'https://z.com/a/b'); }

// 12. logged URL is redacted end to end
{ const e = makeEnv(); e.st.url = 'https://app.example.com/reset?token=SECRET123&lang=en'; await e.tick(0); await e.tick(30_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('sent URL has token masked', e.sent.length === 1 && e.sent[0].url === 'https://app.example.com/reset?token=REDACTED&lang=en', e.sent[0]?.url); }

// 13. new default blocklist entries
{ const e = makeEnv(); e.st.url = 'https://my.1password.com/vaults'; await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('password manager ignored by default', e.sent.length === 0 && e.ctx.reads() === 0); }

// 14. browser label
{ const e = makeEnv(); await e.tick(0); await e.tick(30_000); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('entries are labelled chrome by default', e.sent[0]?.browser === 'chrome', e.sent[0]?.browser); }
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';
{ const e = makeEnv({ noIdle: true, ua: SAFARI_UA }); await e.activity(); await e.tick(0); await e.tick(30_000); await e.activity(); e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('Safari UA => labelled safari', e.sent[0]?.browser === 'safari', e.sent[0]?.browser); }

// 15. Safari has no idle API: activity messages stand in for it
{ const e = makeEnv({ noIdle: true, ua: SAFARI_UA });
  await e.tick(0); await e.tick(60_000); e.st.focused = false; await e.tick(0); await e.tick(60_000); await e.tick(0);
  check('no idle API and no activity ever => nothing logged', e.sent.length === 0, JSON.stringify(e.sent.map(x => x.focused_s))); }
{ const e = makeEnv({ noIdle: true, ua: SAFARI_UA });
  await e.activity(); await e.tick(0); await e.tick(25_000); await e.activity();           // 25s of real use
  for (let i = 0; i < 14; i++) await e.tick(30_000);                                        // then 7 min of no input, tick every 30s
  const f = e.sent[0]?.focused_s;
  check('inactivity ends the visit after ~5 min (not 7+)', e.sent.length === 1 && f >= 300 && f <= 360, String(f)); }
{ const e = makeEnv({ noIdle: true, ua: SAFARI_UA });
  await e.activity(); await e.tick(0);
  for (let i = 0; i < 6; i++) { await e.tick(120_000); await e.activity(); }                // input every 2 min for 12 min
  e.st.url = 'https://other.com/'; await e.tick(0);
  check('regular activity keeps one continuous visit', e.sent.length === 1 && e.sent[0].focused_s >= 700, JSON.stringify(e.sent.map(x => x.focused_s))); }

// 16. Safari rejects null in storage: a finished visit must be logged exactly once, not re-sent every tick
{ const e = makeEnv({ noIdle: true, ua: SAFARI_UA, rejectNull: true });
  await e.activity(); await e.tick(0); await e.tick(30_000); await e.activity();
  e.st.focused = false; await e.tick(0);                       // leave the page
  for (let i = 0; i < 12; i++) await e.tick(30_000);           // six minutes of ticks with nothing focused
  check('null-rejecting storage: the visit is logged exactly once', e.sent.length === 1, `sent ${e.sent.length} times`);
  check('null-rejecting storage: the finished visit is cleared from state', !('visit' in e.store) || e.store.visit == null, JSON.stringify(e.store.visit)?.slice(0, 60)); }

// 17. nothing is sent until the new state is saved (a failed save must not cause re-sends later)
{ const e = makeEnv();
  await e.tick(0); await e.tick(30_000); e.st.focused = false; await e.tick(0);   // visit is closed, waiting out the merge gap
  e.ctl.failVisitSet = true; await e.tick(30_000);                                // this run finalises it, but saving state fails
  check('failed state save => nothing sent that run', e.sent.length === 0, `sent ${e.sent.length}`);
  await e.tick(0); await e.tick(30_000); await e.tick(30_000);
  check('and it is delivered once after the save works again', e.sent.length === 1, `sent ${e.sent.length}`); }

// 18. read the page once it has loaded, not only after 20s: people often leave just after qualifying
{ const e = makeEnv(); await e.tick(0); e.advance(24_000); e.st.url = 'https://elsewhere.com/'; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('24s visit, left before the next check: page text was captured on load', e.sent[0]?.focused_s === 24 && e.sent[0]?.text === 'text of https://a.com/', JSON.stringify(e.sent.map(x => [x.focused_s, x.text]))); }
{ const e = makeEnv(); e.st.status = 'loading'; await e.tick(0); await e.tick(10_000);
  check('page still loading => not read yet', e.ctx.reads() === 0, String(e.ctx.reads()));
  e.st.status = 'complete'; await e.tick(0);
  check('read as soon as it finishes loading', e.ctx.reads() === 1, String(e.ctx.reads())); }
{ const e = makeEnv(); e.st.pageText = 'Loading…'; await e.tick(0);                      // first read finds the page still rendering
  e.st.pageText = 'The full article text. '.repeat(40); await e.tick(30_000);              // qualifies: one refresh picks up the real text
  e.st.focused = false; await e.tick(0); await e.tick(30_000); await e.tick(0);
  check('short first read is refreshed once the visit qualifies', e.sent[0]?.text?.startsWith('The full article'), e.sent[0]?.text?.slice(0, 30)); }
{ const e = makeEnv(); e.st.pageText = 'A full article. '.repeat(60); await e.tick(0); await e.tick(30_000); await e.tick(30_000); await e.tick(30_000);
  check('a normal page is read once, not over and over', e.ctx.reads() === 1, String(e.ctx.reads())); }
{ const e = makeEnv(); e.st.pageText = 'Tiny page.'; await e.tick(0); for (let i = 0; i < 8; i++) await e.tick(30_000);
  check('a very short page is read at most twice (load + one refresh)', e.ctx.reads() === 2, String(e.ctx.reads())); }
{ const e = makeEnv(); e.st.url = 'https://www.youtube.com/watch?v=1'; await e.tick(0); await e.tick(30_000);
  check('log-time-only pages are still never read', e.ctx.reads() === 0, String(e.ctx.reads())); }

process.exit(failures ? 1 : 0);
