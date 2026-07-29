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
