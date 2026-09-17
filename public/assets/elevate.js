// The house's elevation layer — the depth cues the design already implies,
// made to respond.
//
// Four things, and deliberately only four. Each one reports a fact the reader
// already has (how far down the page they are, where their pointer is, that
// the header is no longer at the top of the document) back to CSS as a custom
// property or an attribute, and the stylesheet decides what that looks like.
// No animation is driven from here: JavaScript measures, CSS moves. That is
// what keeps this file the same size on the day somebody redesigns the cards.
//
//   1. Read progress   — a hairline under the header, filling as the page goes.
//   2. The docked header — [data-scrolled] once the page has left the top.
//   3. Pointer light    — --px/--py on a lifted surface, so its sheen follows
//                         the cursor. Fine pointers only; a thumb has no
//                         position to follow and a phone has no cycles to
//                         spare on one.
//   4. Depth on the dark stage — the drifting orbs take a slow parallax off
//                         the scroll position, so the dark sections have a
//                         back wall rather than a flat one.
//
// Everything here is additive. With JS off the page is exactly the site it
// was: the progress line never appears, the header keeps its resting padding,
// the cards keep their plain hover, and nothing is missing that carried
// meaning. prefers-reduced-motion turns all of it off at the source rather
// than leaving listeners running against rules that no longer apply.
(function () {
  'use strict'

  var root = document.documentElement
  root.classList.add('js')

  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (calm) return

  root.classList.add('elevated')

  // ------------------------------------------------------- read + dock
  // One scroll listener for both, coalesced onto a frame. Scroll fires far
  // faster than the screen refreshes, and doing this work per event rather
  // than per frame is the classic way to make a smooth page feel heavy.
  var header = document.querySelector('.site-header')
  var line = null

  if (header) {
    line = document.createElement('span')
    line.className = 'read-line'
    line.setAttribute('aria-hidden', 'true')
    header.appendChild(line)
  }

  var docked = false
  var queued = false

  function measure() {
    queued = false
    var y = window.pageYOffset || root.scrollTop || 0

    if (header) {
      var now = y > 12
      if (now !== docked) {
        docked = now
        if (now) header.setAttribute('data-scrolled', '')
        else header.removeAttribute('data-scrolled')
      }
    }

    if (line) {
      // The runway is the part of the document that can actually be scrolled.
      // On a page shorter than the viewport that is zero, and a line that is
      // permanently full says nothing — so it stays empty instead.
      var runway = root.scrollHeight - window.innerHeight
      line.style.transform = 'scaleX(' + (runway > 40 ? Math.min(1, y / runway) : 0) + ')'
    }

    // The dark stage's orbs, given somewhere to be. A fraction of the scroll
    // distance, capped, so the effect is depth rather than travel.
    root.style.setProperty('--scroll-depth', Math.min(140, y * 0.06).toFixed(1) + 'px')
  }

  function onScroll() {
    if (queued) return
    queued = true
    window.requestAnimationFrame(measure)
  }

  measure()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })

  // ------------------------------------------------------- pointer light
  // A soft highlight that sits where the cursor is, on the surfaces that are
  // already lifted off the page. Delegated from the document rather than bound
  // per card, because the storefront mints cards after this file has run.
  var fine = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  if (!fine) return

  var LIT = '.card, .prod-card, .vig, .door, .form-card, .band-sage, .panel-tint, .num-card, .cd'
  var lit = null
  var atX = -1
  var atY = -1

  function light(over, x, y) {
    if (over !== lit) {
      if (lit) lit.removeAttribute('data-lit')
      lit = over
      if (lit) lit.setAttribute('data-lit', '')
    }
    if (!lit) return
    // getBoundingClientRect on every move is a read against a layout the
    // browser has already computed for this frame — cheap, and correct
    // through every scroll, resize and reflow without caching any of them.
    var box = lit.getBoundingClientRect()
    lit.style.setProperty('--px', ((x - box.left) / box.width) * 100 + '%')
    lit.style.setProperty('--py', ((y - box.top) / box.height) * 100 + '%')
  }

  document.addEventListener(
    'pointermove',
    function (event) {
      atX = event.clientX
      atY = event.clientY
      light(event.target && event.target.closest ? event.target.closest(LIT) : null, atX, atY)
    },
    { passive: true }
  )

  document.addEventListener('pointerleave', function () {
    atX = atY = -1
    light(null, 0, 0)
  })

  // A page scrolling under a still cursor moves a different surface under it.
  // Asking what is there now — rather than simply dropping the highlight — is
  // what stops it blinking off through every smooth anchor scroll.
  window.addEventListener(
    'scroll',
    function () {
      if (atX < 0) return
      var under = document.elementFromPoint(atX, atY)
      light(under && under.closest ? under.closest(LIT) : null, atX, atY)
    },
    { passive: true }
  )
})()
