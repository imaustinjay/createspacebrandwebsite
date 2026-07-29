// Live season status on the application doors. Fills [data-season] slots from
// /api/seasons (which reads the workspace's open casting cycles). If the API
// isn't configured or can't answer, the slots stay hidden — unknown is not
// the same as closed, and the doors themselves remain the source of truth.
(function () {
  var slots = document.querySelectorAll('[data-season]')
  if (!slots.length) return

  fetch('/api/seasons')
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || !d.ok) return
      slots.forEach(function (el) {
        var division = el.getAttribute('data-season')
        var cycle = d[division]
        var label = el.getAttribute('data-label') || division
        var mode = el.getAttribute('data-mode') || 'pill'
        var cls = el.getAttribute(cycle ? 'data-open-class' : 'data-closed-class')
        if (cls) el.className = cls
        if (mode === 'line') {
          el.textContent = cycle
            ? 'The ' + label + ' door is open right now — ' + cycle.season + ' ' + cycle.year + '.'
            : label + ' is between seasons just now — the door reopens quarterly.'
        } else {
          el.textContent = cycle
            ? 'Open now · ' + cycle.season + ' ' + cycle.year
            : 'Between seasons just now'
        }
        el.hidden = false
      })
    })
    .catch(function () {})
})()
