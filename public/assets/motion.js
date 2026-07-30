// Studio motion — word-by-word headline arrivals and the rotating proof line.
// Everything degrades to stillness: no JS leaves headlines whole and the first
// proof statement in place; reduced motion is honoured throughout.
(function () {
  document.documentElement.classList.add('js')
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Split [data-words] headlines into word spans, preserving nested emphasis
  // spans, so each word can settle in on its own beat.
  document.querySelectorAll('[data-words]').forEach(function (root) {
    var i = 0
    ;(function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var frag = document.createDocumentFragment()
          child.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return
            if (/^\s+$/.test(part)) {
              frag.appendChild(document.createTextNode(part))
            } else {
              var s = document.createElement('span')
              s.className = 'w'
              s.style.setProperty('--i', i++)
              s.textContent = part
              frag.appendChild(s)
            }
          })
          node.replaceChild(frag, child)
        } else if (child.nodeType === 1) {
          walk(child)
        }
      })
    })(root)
  })

  // Mobile navigation. The panel itself is CSS, driven off [data-nav-open] on
  // the header; this manages state and every way back out: Escape, a tap
  // outside, following a link, or growing past the mobile breakpoint.
  var header = document.querySelector('.site-header')
  var toggle = document.querySelector('.nav-toggle')
  if (header && toggle) {
    var setOpen = function (open) {
      if (open) header.setAttribute('data-nav-open', '')
      else header.removeAttribute('data-nav-open')
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    toggle.addEventListener('click', function () {
      setOpen(!header.hasAttribute('data-nav-open'))
    })
    header.querySelectorAll('.nav a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false) })
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.hasAttribute('data-nav-open')) {
        setOpen(false)
        toggle.focus()
      }
    })
    document.addEventListener('click', function (e) {
      if (header.hasAttribute('data-nav-open') && !header.contains(e.target)) setOpen(false)
    })
    // Rotating to landscape can cross the breakpoint while the panel is open,
    // which would otherwise strand it over the desktop layout.
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) setOpen(false)
    })
  }

  // The rotating proof line — one true statement at a time, on a slow turn.
  var line = document.querySelector('[data-rotate]')
  if (!line || calm) return
  var items = []
  try { items = JSON.parse(line.getAttribute('data-rotate')) } catch (e) {}
  if (!Array.isArray(items) || items.length < 2) return
  var idx = 0
  setInterval(function () {
    line.style.opacity = '0'
    line.style.transform = 'translateY(6px)'
    setTimeout(function () {
      idx = (idx + 1) % items.length
      line.textContent = items[idx]
      line.style.opacity = '1'
      line.style.transform = 'none'
    }, 420)
  }, 4600)
})()
