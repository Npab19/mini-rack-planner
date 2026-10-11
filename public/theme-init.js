// Applies the saved/OS colour theme before React mounts (avoids a light flash).
// Kept as an external file so the Content-Security-Policy never needs 'unsafe-inline' for scripts.
;(function () {
  var theme = 'system'
  try {
    theme = window.localStorage.getItem('mrp-theme') || 'system'
  } catch (e) {
    /* storage can be blocked (private mode, LAN origins) — fall back to system */
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
})()
