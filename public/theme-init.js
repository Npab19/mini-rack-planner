// Applies the saved/OS colour theme and the saved accent before React mounts (avoids a flash).
// Kept as an external file so the Content-Security-Policy never needs 'unsafe-inline' for scripts.
// The accent list mirrors ACCENTS in src/lib/theme.ts; indigo, the default, needs no attribute.
;(function () {
  var theme = 'system'
  var accent = null
  try {
    theme = window.localStorage.getItem('mrp-theme') || 'system'
    accent = window.localStorage.getItem('mrp-accent')
  } catch (e) {
    /* storage can be blocked (private mode, LAN origins) — fall back to system and the default */
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  var accents = ['blue', 'teal', 'green', 'orange', 'rose', 'graphite']
  if (accents.indexOf(accent) !== -1) document.documentElement.setAttribute('data-accent', accent)
})()
