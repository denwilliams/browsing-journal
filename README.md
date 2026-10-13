# Browsing Journal

A Chrome and Safari extension that keeps a private, local journal of the pages you actually spend time on.
For each page you get the URL, title, timestamps, how long you really had it focused, and a
short summary and category produced by Apple's on-device model. Nothing leaves your machine.

```
{"url":"https://go.dev/doc/effective_go","title":"Effective Go","start":"2026-10-13T19:00:00+11:00",
 "end":"2026-10-13T19:02:00+11:00","focused_s":95,
 "summary":"This page provides tips for writing clear, idiomatic Go code…","category":"documentation"}
```

One line per visit, in `~/browsing-journal/YYYY-MM-DD.jsonl` (JSON Lines: one JSON object per line).

## How it works

```
Browser extension ──POST /visit──▶ Swift server (127.0.0.1:47821) ──▶ ~/browsing-journal/2026-10-13.jsonl
 tracks focus + idle              │
 reads page text                  └─ summarises in-process ─▶ Apple on-device model
```

| Part | Where | Job |
|---|---|---|
| Chrome extension | `chrome/` | Decides what counts as a visit, reads the page text, sends finished visits to the server. Its code is also what the Safari build packages |
| Safari packaging | `safari/` | Safari's manifest, an activity script and a build script that wraps the code from `chrome/` in the macOS app Safari needs |
| Server | `server/main.swift` | One Swift file, no dependencies. Listens on loopback (Network.framework), accepts visits from the extension, summarises each page with Apple's Foundation Models, appends to the daily file |

### What counts as a visit

- **Only focused time counts.** Time only accrues while Chrome is the frontmost app, the page's
  tab is the active one in the focused window, and you are not idle (no input for 5 minutes, or
  the screen is locked). A tab left open overnight records nothing.
- **Accidental switches are forgiven.** If you leave a page and come back to it within 20
  seconds, it's one visit and only the focused seconds are counted.
- **Short visits are dropped.** A visit needs at least **20 seconds** of focused time. Anything
  less is discarded inside the browser and never reaches the server.
- **A visit is written when it ends:** when you move to a different page, or you've been away
  from it for 20 seconds or more. Entries therefore appear a little after you leave a page.
- Incognito windows, `chrome://` pages and non-http(s) pages are never tracked.
- **Summaries are plain-text, two-line replies** (`CATEGORY:` and `SUMMARY:`) from the on-device model.
  Structured output was dropped because the model's safety guardrails refuse it for news about crime
  and death even when it will summarise the same text as plain text. If the default mode still
  refuses a page, the server retries once in the model's permissive text-transformation mode.
- **Repeats are ignored.** If a browser re-sends a visit (for example after failing to save its own
  state), the server drops any visit whose URL and start time it has already logged. It remembers
  the last 500 since it started.

The thresholds are constants at the top of `chrome/background.js` (`MIN_DWELL_MS`,
`MERGE_GAP_MS`, `IDLE_SEC`).

### Site lists

The popup (toolbar icon) has a pause switch and two lists. Entries match the host and all its
subdomains: `google.com` also matches `docs.google.com`, so use a full host such as
`www.google.com` to target one site.

- **Never log:** the page is invisible: not recorded, not read. Defaults cover mail, calendar,
  chat, sign-in pages, password managers, payment providers, some banks and some government
  sites (see `chrome/shared.js`).
- **Log time only:** the visit is recorded (URL, title, focused time) but the page text is never
  read, never sent to the server and never summarised. Defaults: search engines, YouTube, X,
  Reddit. Use this for sites where you want to see how much time you spend but not have the
  content processed, such as Gmail: move `mail.google.com` here from "Never log". The title and
  URL are still logged, so an email's subject line (which Gmail puts in the tab title) will
  appear in the journal even though the body never does. See "Sensitive content" below.

The defaults are only used until you first edit a list in the popup. After that your saved lists
replace them, so later changes to the defaults won't reach you. Add new entries by hand.

## Install

Requirements: macOS 26 or later on Apple silicon with Apple Intelligence enabled (for the
on-device model) and a Swift toolchain (the Xcode Command Line Tools are enough for the server).
Chrome, and for Safari, Xcode.

### 1. Install the server and start it at login

```sh
./install.sh
```

This builds the server, installs it to `~/.local/bin`, installs
the launchd agent and starts it. The agent runs the installed copy, so the repo can live
anywhere and can be moved or deleted afterwards. Re-run the script after pulling changes to
update.

- `./install.sh --no-agent` installs the binaries only.
- `./install.sh uninstall` stops the agent and removes the binaries and plist. Journal files in
  `~/browsing-journal` are never touched.

launchd doesn't expand `$HOME` in plists, so the agent runs
`/bin/sh -c 'exec "$HOME/.local/bin/journal-server"'`. Nothing in it is specific to a user or to
where you cloned the repo. Logs go to `~/Library/Logs/browsing-journal.log`.

**Server flags** (to use them, run the server yourself or edit the plist): `-addr` (default
`127.0.0.1:47821`; only loopback is accepted), `-dir` (default `~/browsing-journal`) and `-ext-id`
(accept only these extension IDs, comma-separated, Chrome and Safari alike; without it, any browser extension can post to the server). Flags
take a separate value: `-dir ~/somewhere`.

If the on-device model is unavailable or a summary fails, the visit is still logged, just without
a summary.

#### Starting at login

**Known issue:** on the machine this was built on, launchd reported `domain in on-demand-only mode`
and would not start `RunAtLoad` / `KeepAlive` jobs on its own. Only an explicit `kickstart` worked.
Whether it starts by itself at login is not confirmed. After logging in, check:

```sh
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:47821/health    # 204 = running, 000 = not
```

and if it's not running, run `./install.sh` again (or `launchctl kickstart gui/$(id -u) com.den.browsing-journal`).

To stop and remove it, run `./install.sh uninstall`.

#### Building by hand

```sh
swiftc -O server/main.swift -o journal-server
./journal-server
```

### 2. Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and choose the `chrome/` folder.
3. Optionally copy the extension's ID and run the server with `-ext-id <id>`.
4. After editing extension files, press the reload arrow on its card.

Chrome remembers the folder it loaded the extension from. If you move the repo, remove the
extension and load it again from the new location.

Chrome will warn that the extension can "read and change all your data on all websites". That
permission is how it reads page text for the summaries. See "Sensitive content" below.

## The journal files

Each line has these fields:

| Field | Meaning |
|---|---|
| `url` | Page URL with the `#fragment` removed and credentials in the query string masked (see below) |
| `title` | Tab title |
| `start`, `end` | Local time with offset |
| `focused_s` | Seconds actually focused, excluding idle time and time away |
| `browser` | `chrome` or `safari`. Absent on entries written before Safari support |
| `summary` | One or two sentences from the on-device model. Absent for "log time only" sites, or if the model was unavailable |
| `category` | `engineering`, `documentation`, `news`, `research`, `social`, `shopping`, `entertainment`, `communication`, `finance`, `travel`, `productivity` or `other` |

Files are created with mode `0600` in a `0700` directory. They are plain, unencrypted text.
Because they are plain JSONL, any tool can read them, e.g. `jq -r .title ~/browsing-journal/*.jsonl`.

### 3. Safari (optional)

Safari extensions have to live inside a small macOS app, so this one is built rather than loaded
from a folder:

```sh
./safari/build.sh        # produces safari/build/Browsing Journal.app
```

The script copies the shared extension files, swaps in Safari's manifest, runs Apple's
`safari-web-extension-converter` and builds the app with Xcode. It is signed ad hoc, so Safari
only loads it with unsigned extensions allowed:

1. Safari ▸ Settings ▸ Advanced ▸ turn on **Show features for web developers**.
2. Develop menu ▸ **Allow Unsigned Extensions**. Safari forgets this every time it quits, so you
   repeat it after each restart. (Signing it yourself removes this step; see below.)
3. Move `Browsing Journal.app` somewhere like `~/Applications` and open it once so Safari sees it.
4. Safari ▸ Settings ▸ Extensions ▸ tick **Browsing Journal**, then under permissions choose
   **Allow on every website**. Without that, Safari hides tab URLs and page text from it.

**Signing it yourself.** With your own signing certificate you can skip the Develop-menu step:

1. In Xcode: Settings ▸ Accounts ▸ **+** ▸ add your Apple ID. A free account gets a "Personal
   Team"; a paid developer account works too.
2. Find your team ID (a 10-character code). Xcode doesn't always show it in the Accounts pane, so
   either pick your team under Signing & Capabilities in the generated project
   (`safari/build/Browsing Journal/Browsing Journal.xcodeproj`) and read it back with
   `grep -m1 DEVELOPMENT_TEAM` on its `project.pbxproj`, or, once Xcode has made an Apple
   Development certificate, read the `OU=` value from
   `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.
   (The code in brackets in `security find-identity` output is not the team ID.)
3. Rebuild with it: `TEAM_ID=ABCDE12345 ./safari/build.sh`, then copy the app to `~/Applications`
   and enable it in Safari as above. Safari should now load it without **Allow Unsigned
   Extensions**.

This path is untested here, because no signing identity was available when it was written. With a
free Personal Team, Apple may expire the certificate or provisioning profile periodically (for
some app types as often as every 7 days), after which you rebuild. Only a paid account's Developer
ID signing, plus notarisation, gives an app that never expires.

Safari differs from Chrome in two ways that matter here:

- **No idle API.** Chrome tells the extension when you're idle or the screen locks; Safari
  doesn't. Instead a small script on each page reports keyboard and mouse activity (never page
  content). A visit stops counting after 5 minutes without input, checked every 30 seconds, so it
  can run up to 30 seconds over. Screen lock isn't detected.
- **Different extension ID.** Safari identifies the extension to the server by its own ID. To lock
  the server to specific extensions, pass both: `-ext-id <chrome id>,<safari id>`. The server
  accepts either scheme for any listed ID.

Entries from Safari carry `"browser":"safari"`, and from Chrome `"browser":"chrome"`.

## Sensitive content

This tool reads what's on your screen, so it's worth being clear about what it does and doesn't
protect.

### What is sent where

For each finished visit the extension POSTs to the local server only (`127.0.0.1`, never the
internet): the URL, title, start and end time, focused seconds, and up to 6000 characters of the
page's visible text. The server passes the text to the on-device model and **discards it**. Only
the URL, title, times, summary and category are written to disk.

If the server is down, finished visits wait in the extension's local storage (text included, up
to 300 of them) and are sent when it comes back.

### What is protected

- **Never-log sites** are not recorded and not read.
- **Log-time-only sites** are never read.
- **Pages are read in the browser as soon as they load**, because by the time a visit qualifies
  the tab has often moved on. That text stays in the extension's local storage and is only sent to
  the server if the visit lasts 20 seconds.
- **Pages with a password, credit-card (`autocomplete="cc-*"`) or one-time-code field** are not
  read. The visit is still logged with its URL, title and time.
- **Query-string credentials are masked** in the logged URL: parameters whose names look like
  `token`, `secret`, `password`, `auth`, `session`, `signature`, `jwt`, `otp`, `api_key`, `code`,
  `key`, `sig` or `state` become `REDACTED`, and `user:pass@` is removed. Ordinary parameters
  such as `q` and `v` are kept.
- **Visits under 20 seconds** are discarded in the browser and never sent, including any page text read for them.
- **Incognito windows** are never tracked, and the extension isn't enabled in them by default.
- **Pause** stops all logging from the popup.
- **The server only accepts the extension.** It rejects requests that lack a
  `chrome-extension://` Origin, use a non-loopback Host (DNS rebinding), or aren't JSON, so a web
  page can't write to your journal. Pass `-ext-id` to also exclude other extensions.

### What is not protected

- **Anything on screen at a site you haven't listed.** The page text is whatever is visible: if
  you view a medical result, a payslip or a private document on a site that isn't in "Never log"
  or "Log time only", its text goes to the model and a summary of it is written to the journal.
  The default lists are a starting point. Add your own bank, super fund, health provider,
  employer tools and so on.
- **Titles and URL paths.** An email subject, a document name or `/invoice/48213` is logged even
  if the body isn't. Only query-string credentials are masked.
- **Secrets that aren't in a query parameter named like a secret**, for example a token in the
  URL path, or a parameter with an unusual name.
- **Pages without a password or card field** that still show sensitive text, such as a logged-in
  account dashboard.
- **Files at rest are not encrypted.** They rely on macOS permissions and FileVault.
- **Anything you hand to an AI assistant.** If you point an assistant such as Claude at the
  journal to summarise your week, the URLs, titles and summaries you share become part of that
  conversation. Consider which days or categories you share.
- **Summaries are model output.** They can paraphrase sensitive details, and they can be wrong.

### Good habits

- Put sensitive sites in **Never log** before you use them, not after.
- Use **Pause** (or an incognito window) for anything one-off and sensitive.
- To remove something, delete its line from the day's `.jsonl` file. There is no other copy.
- Review `~/browsing-journal` from time to time and tighten the lists.

## Testing

The extension's focus and dwell logic is tested against a mocked `chrome` API with a fake clock:

```sh
cd chrome
node test-bg.mjs background.js
```

It covers the 20s threshold, merging across short blurs, idle time (including Safari's
activity-based fallback), the never-log and log-time-only lists, pause, delivery retry, URL
redaction and the browser label. It doesn't exercise a real browser.
The server can be tested by hand with `curl`, using a `chrome-extension://…` Origin header and
`Content-Type: application/json`.

## Troubleshooting

| Symptom | Check |
|---|---|
| No journal file | Is the server running (`curl 127.0.0.1:47821/health` should print 204)? Is the extension loaded and not paused? Remember an entry only appears after you leave the page, and visits under 20s are dropped |
| Safari: extension doesn't appear in Settings ▸ Extensions | Is **Allow Unsigned Extensions** on (Develop menu)? It resets when Safari quits. Has `Browsing Journal.app` been opened once? |
| Safari: nothing is logged | The extension needs **Allow on every website**. Without it Safari hides tab URLs. Check the popup's server status, and that the server accepts Safari's origin (don't pass a Chrome-only `-ext-id`) |
| Popup says "Server NOT running" | Run `./install.sh`, or `launchctl kickstart gui/$(id -u) com.den.browsing-journal` |
| Entries have no `summary` | The site may be log-time-only. Otherwise check the server log (`~/Library/Logs/browsing-journal.log`). A line like `summarize <url>: Response may contain sensitive or unsafe content` means Apple's on-device model refused that page even after the retry in its more permissive mode (very graphic or distressing content, usually); the visit is still logged without a summary. The log also says at startup if the model is unavailable, which needs Apple Intelligence enabled |
| Server won't start: address in use | Another copy is running. `pgrep -fl journal-server` and stop it, or `launchctl bootout` the agent |
| launchd agent loaded but not running | See the on-demand-only note under "Starting at login" |

## Limitations

- Chrome and Safari only. There is no Firefox version.
- The Safari build has not been run in Safari yet: it builds and passes its structural checks, and the shared logic (including the idle fallback) is tested against a mock, but nothing has been seen working in the real browser. Treat it as untested.
- Summaries queue in memory. If the server is killed while visits are queued, those entries are
  lost.
- Windows that aren't `normal` Chrome windows (DevTools, app windows) aren't tracked.
- Video and reading without touching the keyboard or mouse count as idle after 5 minutes.
- Search result pages and similar summarise poorly, which is why they default to log-time-only.
