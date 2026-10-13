// Shared by the service worker (importScripts) and the popup (<script>).
// Entries match the host itself and any subdomain: "google.com" also matches "mail.google.com",
// so use the full host ("www.google.com") to target just one site.
const DEFAULT_SETTINGS = {
  paused: false,
  // Never logged and never read.
  blocklist: [
    // Mail, calendar, chat and sign-in
    'mail.google.com', 'calendar.google.com', 'accounts.google.com', 'myaccount.google.com',
    'outlook.office.com', 'outlook.live.com', 'login.microsoftonline.com',
    'app.slack.com', 'web.whatsapp.com', 'messages.google.com', 'meet.google.com',
    // Password managers
    '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com',
    // Payments, banks and government. Add your own bank, super fund, health provider etc.
    'paypal.com', 'wise.com', 'commbank.com.au', 'anz.com', 'anz.com.au', 'westpac.com.au',
    'nab.com.au', 'ing.com.au', 'my.gov.au', 'ato.gov.au',
  ],
  // Logged (URL, title, focused time) but the page text is never read or summarised.
  metadataOnly: [
    'www.google.com', 'www.bing.com', 'duckduckgo.com', 'youtube.com', 'x.com', 'reddit.com',
  ],
};

function hostMatches(url, list) {
  const host = new URL(url).hostname;
  return list.some((d) => host === d || host.endsWith('.' + d));
}

// Query parameters whose names suggest a credential. "auth(?!or)" spares ?author=.
const SENSITIVE_PARAM =
  /token|secret|passw|pwd|auth(?!or)|session|signature|credential|jwt|bearer|otp|api_?key|access_?key|^(key|code|sig|state)$/i;

// The URL as it is logged: embedded credentials removed, secret-looking query values masked.
function redactUrl(url) {
  const u = new URL(url);
  u.username = '';
  u.password = '';
  for (const name of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(name)) u.searchParams.set(name, 'REDACTED');
  }
  return u.href;
}
