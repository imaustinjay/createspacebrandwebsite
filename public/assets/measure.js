// The beacon. Two small messages per page, to this site's own /api/measure.
//
// What it sends: the path, where the visitor arrived from, where in the visit
// this page falls, how long the page held them, how far down they scrolled,
// and one boolean for whether they went on to another page here. That is the
// whole list.
//
// It does listen for clicks, and it never sends one. A click on an internal
// link only flips a local flag, so that the closing beacon can say "this was
// not the last page" — which link, and where on the page, are never known to
// anything outside this file.
//
// What it does not send, and cannot: a name, an email, an id that survives
// the tab, a cookie, a keystroke, or anything typed into a form. The session
// marker lives in sessionStorage, so it is gone when the tab closes and was
// never readable by another site to begin with.
//
// Nothing here blocks rendering, nothing here throws into the page, and if
// the endpoint is down the visitor never learns that it was.
(function () {
  'use strict'

  var ENDPOINT = '/api/measure'

  // The owner looking at their own site is not foot traffic. The portal sets
  // this, and /admin/ is never counted regardless.
  try {
    if (window.localStorage.getItem('cs.measure.off') === '1') return
  } catch (e) {
    /* private mode — carry on, the counter is not worth an exception */
  }
  if (/^\/admin\//.test(location.pathname) || /^\/shop\/admin\//.test(location.pathname)) return

  // A local preview is not the internet.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return

  var SESSION = 'cs.m.session'
  var path = location.pathname
  var started = Date.now()
  var deepest = 0
  var sent = false

  // Where in the visit this page falls. sessionStorage answers it exactly: it
  // is created when the tab opens and destroyed when it closes, which is the
  // same span a session means.
  //
  // The second page matters as much as the first. The server counts bounces
  // as "sessions that never reached a second page", and it can only do that
  // by pure addition — its day counters are split across eight shards, so a
  // count that has to be taken back later loses the take-back. Naming the
  // second view here is what keeps that arithmetic honest.
  var fresh = false
  var second = false
  try {
    var seen = Number(window.sessionStorage.getItem(SESSION) || 0)
    fresh = seen === 0
    second = seen === 1
    window.sessionStorage.setItem(SESSION, String(seen + 1))
  } catch (e) {
    // No sessionStorage means every page looks like a new visit, which would
    // read as "everybody bounces". Better to count no session at all than to
    // count a wrong one.
    fresh = false
    second = false
  }

  function send(payload, beacon) {
    var body = JSON.stringify(payload)
    try {
      if (beacon && navigator.sendBeacon) {
        // A Blob, not a string: sendBeacon sends text/plain otherwise, and
        // the function reads JSON.
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
        return
      }
    } catch (e) {
      /* fall through to fetch */
    }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
        mode: 'same-origin',
      }).catch(function () {
        /* a counter that fails is a counter that fails quietly */
      })
    } catch (e) {
      /* nothing left to try, and nothing worth telling the reader */
    }
  }

  // ------------------------------------------------------------- the visit
  send({ k: 'view', p: path, r: document.referrer || '', n: fresh, s2: second }, false)

  // ------------------------------------------------- is this the last page?
  //
  // pagehide fires whether somebody closed the tab or clicked through to the
  // next page, and those are opposite answers to "did the visit end here".
  // Nothing in the event distinguishes them, so watch for the click instead:
  // if a link to somewhere on this site was taken, the next page is already
  // coming and this one is not where the visit ended.
  //
  // It is an inference, not a fact. A middle-click, a typed URL and a
  // bookmark all read as leaving, which is the safe direction to be wrong in:
  // an exit page that is really a click-through is a smaller error than
  // marking every page an exit, which is what the naive version did.
  var goingInternal = false

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (!link) return
    if (link.target && link.target !== '_self') return
    if (link.hasAttribute('download')) return
    var href = link.getAttribute('href') || ''
    // An anchor on this page is not leaving it.
    if (href.charAt(0) === '#') return
    if (link.protocol && link.protocol !== 'http:' && link.protocol !== 'https:') return
    if (link.hostname && link.hostname !== location.hostname) return
    goingInternal = true
  }, true)

  document.addEventListener('submit', function (event) {
    var form = event.target
    if (!form || !form.action) return
    try {
      if (new URL(form.action, location.href).hostname === location.hostname) goingInternal = true
    } catch (e) {
      /* a form we cannot resolve is not evidence of anything */
    }
  }, true)

  // -------------------------------------------------------- how far down
  function depth() {
    var doc = document.documentElement
    var scrolled = window.pageYOffset || doc.scrollTop || 0
    var reachable = Math.max(1, (doc.scrollHeight || 0) - window.innerHeight)
    var pct = Math.round(((scrolled + window.innerHeight) / (doc.scrollHeight || window.innerHeight)) * 100)
    if (reachable <= 1) pct = 100 // a page shorter than the window was fully read
    if (pct > deepest) deepest = Math.min(100, pct)
  }
  depth()

  var ticking = false
  window.addEventListener(
    'scroll',
    function () {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(function () {
        depth()
        ticking = false
      })
    },
    { passive: true }
  )

  // ------------------------------------------------------- how long it held
  //
  // pagehide is the one event that fires reliably on every browser including
  // iOS Safari, where unload does not. visibilitychange covers the tab being
  // switched away from and never coming back. Both can fire, so `sent` makes
  // sure the time is only counted once.
  function close() {
    if (sent) return
    sent = true
    send({ k: 'dwell', p: path, ms: Date.now() - started, sc: deepest, last: !goingInternal }, true)
  }

  window.addEventListener('pagehide', close)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') close()
  })

  // A page restored from the back/forward cache is a fresh read of it, so
  // start the clock again rather than reporting a second of it.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) {
      started = Date.now()
      deepest = 0
      sent = false
      goingInternal = false
      send({ k: 'view', p: path, r: document.referrer || '', n: false, s2: false }, false)
    }
  })
})()
