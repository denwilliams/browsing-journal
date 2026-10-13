// Safari has no idle API, so each page reports "someone is using this" instead.
// Throttled to one message per 5 seconds; the content of the page is never touched.
(() => {
  let last = 0;
  const ping = () => {
    const now = Date.now();
    if (now - last < 5000) return;
    last = now;
    try {
      const sent = chrome.runtime.sendMessage({ activity: true });
      if (sent && sent.catch) sent.catch(() => {});
    } catch {
      // The extension was reloaded or disabled while this page was open.
    }
  };
  for (const type of ['mousemove', 'keydown', 'pointerdown', 'wheel', 'scroll']) {
    addEventListener(type, ping, { passive: true, capture: true });
  }
})();
