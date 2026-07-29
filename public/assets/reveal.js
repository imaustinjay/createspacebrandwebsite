// Settle-on-arrival for below-fold sections — the house motion verb for
// content arriving. No-JS and reduced-motion both resolve to everything
// visible; the html.js class is what arms the initial hidden state in CSS.
(function () {
  if (!('IntersectionObserver' in window)) return
  document.documentElement.classList.add('js')
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('settled')
          io.unobserve(en.target)
        }
      })
    },
    { rootMargin: '0px 0px -8% 0px' }
  )
  document.querySelectorAll('[data-settle]').forEach(function (el) { io.observe(el) })
})()
