// Live status for The Collection Program's page.
//
// Reads /api/cohort-status, which netlify.toml proxies to the workspace app —
// the single source of truth for whether a window is open. The page is written
// so that if this never answers, it still reads correctly: the static copy says
// the program runs in announced cycles, and only the live bits are filled in
// here. Unknown is not the same as closed.
//
// Nothing on this page is a date, a price or a seat count in the HTML. If the
// product changes its mind about any of them, the page follows within a minute.
(function () {
  var root = document.querySelector('[data-collection]')
  if (!root) return

  var show = function (sel, on) {
    var el = root.querySelector(sel)
    if (el) el.hidden = !on
  }
  var text = function (sel, value) {
    var el = root.querySelector(sel)
    if (el && value) el.textContent = value
  }

  fetch('/api/cohort-status')
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || d.state === 'unconfigured') return

      // No cycle on the books yet: the page collects interest and says plainly
      // that it will write.
      if (d.state === 'none' || d.state === 'draft') return

      text('[data-cycle-name]', d.name)
      if (d.startDate) {
        text('[data-start]', 'We begin ' + fmt(d.startDate) + '.')
        show('[data-start]', true)
      }

      if (d.state === 'applications' && !d.soldOut) {
        show('[data-notify]', false)
        show('[data-apply]', true)
        if (d.applicationsClose) {
          text('[data-close]', 'Applications close ' + fmt(d.applicationsClose) + '.')
          show('[data-close]', true)
        }
        if (typeof d.seatsLeft === 'number' && d.seatsLeft > 0) {
          // Stated, never shouted. No countdown, no "only N left".
          text('[data-seats]', d.seatsLeft + ' of ' + d.seatCap + ' seats still open.')
          show('[data-seats]', true)
        }
      } else if (d.soldOut) {
        text('[data-state-line]', 'This cohort is full. Leave your email and we’ll write when the next one is announced.')
        show('[data-state-line]', true)
      } else if (d.state === 'announced') {
        text('[data-state-line]', 'Announced' + (d.applicationsOpen ? ' — applications open ' + fmt(d.applicationsOpen) + '.' : '.'))
        show('[data-state-line]', true)
      } else if (d.state === 'reviewing' || d.state === 'enrolling') {
        text('[data-state-line]', 'Applications for this cohort have closed and are being read. Leave your email for the next cycle.')
        show('[data-state-line]', true)
      } else if (d.state === 'running') {
        text('[data-state-line]', 'This cohort is underway. The next one is announced at least a month before it starts.')
        show('[data-state-line]', true)
      }
    })
    .catch(function () {})

  function fmt(day) {
    var t = Date.parse(day + 'T12:00:00Z')
    if (!isFinite(t)) return day
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t))
  }

  // The notify list — one field, one honest promise.
  //
  // The list itself lives in the workspace, so that's where an email goes. But
  // the workspace endpoint and this page deploy separately: until the cohort
  // release lands there, /api/cohort-status doesn't exist and a POST would
  // simply fail. So a failed post falls back to the shop desk, which puts the
  // same email in the house inbox. A reader who asked to be told is never lost
  // to a deployment gap — and either way, they're told the truth about it.
  var form = root.querySelector('[data-notify-form]')
  if (!form) return

  var HOUSE_LINE = 'Thank you. We’ll write the moment applications open, and not before.'

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var input = form.querySelector('input[type=email]')
    var out = root.querySelector('[data-notify-result]')
    var button = form.querySelector('button[type=submit]')
    if (!input || !input.value) return

    var email = input.value
    if (button) {
      button.disabled = true
      button.textContent = 'Sending…'
    }

    post('/api/cohort-status', { email: email, source: 'site' })
      .then(function (d) {
        // An unconfigured workspace answers 200 with no `ok` — that is not a
        // list signup, so treat it like any other miss and use the desk.
        if (!d || d.ok !== true) throw new Error('not-listed')
        return d.message || HOUSE_LINE
      })
      .catch(function () {
        return post('/api/shop', { kind: 'cohort', email: email }).then(function (d) {
          if (!d || d.ok !== true) throw new Error('send-failed')
          return HOUSE_LINE
        })
      })
      .then(function (message) {
        if (out) {
          out.textContent = message
          out.hidden = false
        }
        form.hidden = true
      })
      .catch(function () {
        if (out) {
          out.textContent = 'That didn’t send. Try again in a moment, or write to us at hello@createspacebrand.com.'
          out.hidden = false
        }
        if (button) {
          button.disabled = false
          button.textContent = 'Tell me'
        }
      })
  })

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('http-' + r.status)
      return r.json()
    })
  }
})()
