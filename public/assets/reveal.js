// Settle-on-arrival for below-fold sections — the house motion verb for
// content arriving. No-JS and reduced-motion both resolve to everything
// visible; the html.js class is what arms the initial hidden state in CSS.
(function () {
  if (!('IntersectionObserver' in window)) return
  document.documentElement.classList.add('js')
  // The children of a settling section arrive on a stagger, and that stagger is
  // a transition-delay. A delay is not spent when it is used: left on the
  // element it also delays every later transition, so the sixth card in a grid
  // would sit there for half a second before starting to lift under the
  // cursor. Marking the section done once the last child has landed is what
  // takes the delay back off — the CSS does the rest.
  var STAGGER_MS = 1250

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('settled')
          io.unobserve(en.target)
          window.setTimeout(function () {
            en.target.classList.add('settled-done')
          }, STAGGER_MS)
        }
      })
    },
    { rootMargin: '0px 0px -8% 0px' }
  )
  document.querySelectorAll('[data-settle]').forEach(function (el) { io.observe(el) })
})()
