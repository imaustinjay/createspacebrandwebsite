// The portal's behaviour: sign in, read /api/insights, draw it.
//
// Loaded only by /admin/. Written in the same plain-ES5 style as admin.js so
// it needs no build step and no polyfill — the rest of this repo is served
// exactly as it is written, and this page is not going to be the exception.
//
// One rule runs through the whole file: never draw a number the API did not
// send. A panel with no data says what is missing and how to connect it. A
// zero here always means zero, never "we could not tell".
(function () {
  'use strict'

  var portal = document.querySelector('[data-portal]')
  if (!portal) return

  // The owner's own visits are not foot traffic. Set once, here, so opening
  // the portal never inflates the numbers the portal is showing.
  try { window.localStorage.setItem('cs.measure.off', '1') } catch (e) { /* private mode */ }

  var gate = portal.querySelector('[data-gate]')
  var room = portal.querySelector('[data-room]')
  var stepPass = gate.querySelector('[data-step-passphrase]')
  var stepCode = gate.querySelector('[data-step-code]')
  var gateError = gate.querySelector('[data-gate-error]')
  var gateSetup = gate.querySelector('[data-gate-setup]')
  var roomError = room.querySelector('[data-room-error]')
  var loading = room.querySelector('[data-loading]')
  var challenge = ''
  var data = null
  var days = 28
  var busy = false

  // ------------------------------------------------------------- plumbing

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }

  function say(node, message) {
    if (!message) { node.hidden = true; node.textContent = ''; return }
    node.textContent = message
    node.hidden = false
  }

  function api(path, options) {
    var opts = options || {}
    opts.credentials = 'same-origin'
    opts.headers = opts.headers || {}
    if (opts.body) opts.headers['Content-Type'] = 'application/json'
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || 'That did not work.')
          err.reason = body.reason
          err.status = res.status
          throw err
        }
        return body
      })
    })
  }

  var NUM = new Intl.NumberFormat('en-US')
  function n(value) { return NUM.format(Math.round(Number(value) || 0)) }

  function seconds(total) {
    var s = Math.max(0, Math.round(Number(total) || 0))
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    return m + 'm ' + (s % 60) + 's'
  }

  function pct(value, digits) { return (Number(value) * 100).toFixed(digits === undefined ? 1 : digits) + '%' }

  function when(stamp) {
    try { return new Date(stamp).toLocaleString() } catch (e) { return '' }
  }

  // Netlify hands over a two-letter code. The browser already knows every
  // country's name, so there is no table to ship and none to keep current.
  var COUNTRY = null
  try { COUNTRY = new Intl.DisplayNames(['en'], { type: 'region' }) } catch (e) { /* older browser */ }
  function country(code) {
    if (!code) return 'Unknown'
    try { return (COUNTRY && COUNTRY.of(code)) || code } catch (e) { return code }
  }

  // ------------------------------------------------------------- the door

  function showGate(door) {
    gate.hidden = false
    room.hidden = true
    if (!door || door.ok) { gateSetup.hidden = true; return }

    // The door cannot be opened at all. Say exactly which variable is
    // missing — this is the one screen where a vague message costs an hour.
    clear(gateSetup)
    gateSetup.hidden = false
    stepPass.hidden = true
    gateSetup.appendChild(el('h2', null, 'Not set up yet'))
    gateSetup.appendChild(el('p', null, door.message || 'This portal is not configured.'))
    var steps = el('ol')
    var lines = [
      'Netlify → Site configuration → Environment variables.',
      'Add ADMIN_PASSWORD — 24 or more random characters. This is the half you type.',
      'Add ADMIN_SESSION_SECRET — another 24 random characters. This signs the session cookie.',
      'Make sure MAIL_USER and MAIL_PASSWORD are set, so the six-digit code has somewhere to be sent. Optionally set ADMIN_EMAIL to choose which inbox.',
      'Deploys → Trigger deploy. Netlify hands variables to functions at deploy time, so a new one does not exist until the next build.'
    ]
    lines.forEach(function (line) {
      var li = el('li')
      // Variable names are set as code without building HTML from a string:
      // this page never uses innerHTML, on purpose.
      line.split(/\b(ADMIN_PASSWORD|ADMIN_SESSION_SECRET|MAIL_USER|MAIL_PASSWORD|ADMIN_EMAIL)\b/).forEach(function (part, i) {
        li.appendChild(i % 2 ? el('code', null, part) : document.createTextNode(part))
      })
      steps.appendChild(li)
    })
    gateSetup.appendChild(steps)
  }

  function showRoom() {
    gate.hidden = true
    room.hidden = false
  }

  function lockButtons(form, locked, label) {
    var button = form.querySelector('[data-submit]')
    if (!button) return
    button.disabled = locked
    if (locked) {
      button.dataset.was = button.textContent
      button.textContent = label || 'One moment…'
    } else if (button.dataset.was) {
      button.textContent = button.dataset.was
    }
  }

  stepPass.addEventListener('submit', function (event) {
    event.preventDefault()
    say(gateError, '')
    var value = stepPass.querySelector('[name="passphrase"]').value
    if (!value) return
    lockButtons(stepPass, true, 'Checking…')

    api('/api/admin-auth', { method: 'POST', body: JSON.stringify({ step: 'passphrase', passphrase: value }) })
      .then(function (body) {
        stepPass.querySelector('[name="passphrase"]').value = ''
        // One factor only — no mailbox is configured. We are already in; the
        // page says so rather than implying a second step happened.
        if (body.signedIn) {
          showRoom()
          if (body.notice) say(roomError, body.notice)
          return load()
        }
        challenge = body.challenge
        stepPass.hidden = true
        stepCode.hidden = false
        gate.querySelector('[data-sent]').textContent =
          'A six-digit code is on its way to ' + (body.sentTo || 'the house mailbox') + '. It is good for ten minutes.'
        stepCode.querySelector('[name="code"]').focus()
      })
      .catch(function (err) {
        say(gateError, err.message)
        if (err.reason === 'no-passphrase' || err.reason === 'weak-passphrase' || err.reason === 'no-session-secret') {
          showGate({ ok: false, reason: err.reason, message: err.message })
        }
      })
      .then(function () { lockButtons(stepPass, false) })
  })

  stepCode.addEventListener('submit', function (event) {
    event.preventDefault()
    say(gateError, '')
    var code = stepCode.querySelector('[name="code"]').value.trim()
    if (!/^[0-9]{6}$/.test(code)) { say(gateError, 'Six digits.'); return }
    lockButtons(stepCode, true, 'Opening…')

    api('/api/admin-auth', { method: 'POST', body: JSON.stringify({ step: 'code', challenge: challenge, code: code }) })
      .then(function () {
        stepCode.querySelector('[name="code"]').value = ''
        showRoom()
        return load()
      })
      .catch(function (err) {
        say(gateError, err.message)
        if (err.reason === 'expired' || err.reason === 'burned' || err.reason === 'wrong-place') restart()
      })
      .then(function () { lockButtons(stepCode, false) })
  })

  function restart() {
    challenge = ''
    stepCode.hidden = true
    stepPass.hidden = false
    stepPass.querySelector('[name="passphrase"]').focus()
  }
  gate.querySelector('[data-restart]').addEventListener('click', function () { say(gateError, ''); restart() })

  room.querySelector('[data-signout]').addEventListener('click', function () {
    api('/api/admin-auth', { method: 'DELETE' }).then(function () { location.reload() })
  })

  // ------------------------------------------------------------- the read

  function load(refresh) {
    if (busy) return Promise.resolve()
    busy = true
    say(roomError, '')
    loading.hidden = false
    loading.textContent = refresh ? 'Re-crawling the site…' : 'Reading the counters…'

    return api('/api/insights?days=' + days + (refresh ? '&refresh=1' : ''))
      .then(function (body) {
        data = body
        draw()
      })
      .catch(function (err) {
        if (err.status === 401) { showGate(); return }
        say(roomError, err.message)
      })
      .then(function () {
        busy = false
        loading.hidden = true
        var button = room.querySelector('[data-refresh]')
        button.disabled = false
        button.textContent = 'Refresh'
      })
  }

  room.querySelector('[data-refresh]').addEventListener('click', function () {
    this.disabled = true
    this.textContent = 'Working…'
    load(true)
  })

  room.querySelector('[data-range]').addEventListener('change', function () {
    days = Number(this.value) || 28
    load()
  })

  var tabs = [].slice.call(room.querySelectorAll('[data-tab]'))
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.toggle('is-on', t === tab) })
      ;['traffic', 'search', 'suggestions'].forEach(function (name) {
        room.querySelector('[data-panel="' + name + '"]').hidden = name !== tab.dataset.tab
      })
    })
  })

  // ------------------------------------------------------------ components

  function block(title, note) {
    var wrap = el('div', 'p-block')
    var head = el('div', 'p-head')
    head.appendChild(el('h2', null, title))
    if (note) head.appendChild(el('span', 'p-note', note))
    wrap.appendChild(head)
    return wrap
  }

  function stat(label, value, unit, delta, of) {
    var tile = el('div', 'stat')
    tile.appendChild(el('div', 'stat-label', label))
    var v = el('div', 'stat-value', value)
    if (unit) v.appendChild(el('small', null, unit))
    tile.appendChild(v)

    var foot = el('div', 'stat-foot')
    if (delta) {
      var arrow = { up: '↑', down: '↓', flat: '→', 'new': '✦' }[delta.direction] || ''
      var text = delta.percent === null
        ? (delta.direction === 'new' ? 'new' : 'too few to compare')
        : arrow + ' ' + Math.abs(delta.percent) + '%'
      var d = el('span', 'delta', text)
      d.dataset.dir = delta.direction
      foot.appendChild(d)
      foot.appendChild(el('span', 'delta-of', 'vs previous ' + days + ' days'))
    } else if (of) {
      foot.appendChild(el('span', 'delta-of', of))
    }
    if (foot.childNodes.length) tile.appendChild(foot)
    return tile
  }

  function barList(rows, accent, format) {
    var list = el('ul', 'bars')
    var top = rows.reduce(function (max, r) { return Math.max(max, r.count) }, 0) || 1
    rows.forEach(function (row) {
      var li = el('li')
      if (accent) li.dataset.accent = accent
      var fill = el('span', 'bar-fill')
      fill.style.width = Math.max(3, (row.count / top) * 100) + '%'
      li.appendChild(fill)
      var line = el('div', 'bar-row')
      line.appendChild(el('span', 'bar-name', row.label || row.name))
      line.appendChild(el('span', 'bar-count', format ? format(row.count) : n(row.count)))
      li.appendChild(line)
      list.appendChild(li)
    })
    return list
  }

  function table(columns, rows) {
    var scroll = el('div', 'p-scroll')
    var t = el('table', 'p-table')
    var head = el('tr')
    columns.forEach(function (col) {
      var th = el('th', col.num ? 'num' : null, col.label)
      head.appendChild(th)
    })
    t.appendChild(el('thead')).appendChild(head)
    var body = el('tbody')
    rows.forEach(function (row) {
      var tr = el('tr')
      row.forEach(function (cell, i) {
        var td = el('td', columns[i].num ? 'num' : null)
        if (cell && cell.nodeType) td.appendChild(cell)
        else td.textContent = cell === null || cell === undefined ? '—' : String(cell)
        tr.appendChild(td)
      })
      body.appendChild(tr)
    })
    t.appendChild(body)
    scroll.appendChild(t)
    return scroll
  }

  function pathCell(path) { return el('span', 'p-path', path) }

  function pill(text, tone) {
    var p = el('span', 'pill', text)
    p.dataset.tone = tone
    return p
  }

  function empty(heading, lines, steps) {
    var box = el('div', 'p-empty')
    box.appendChild(el('h3', null, heading))
    ;[].concat(lines).forEach(function (line) { box.appendChild(el('p', null, line)) })
    if (steps && steps.length) {
      var ol = el('ol')
      steps.forEach(function (step) {
        var li = el('li')
        // Split on things that should be set as code: env var names, paths
        // and URLs. Same reason as the gate — no innerHTML anywhere here.
        step.split(/(`[^`]+`)/).forEach(function (part) {
          if (part.charAt(0) === '`') li.appendChild(el('code', null, part.slice(1, -1)))
          else li.appendChild(document.createTextNode(part))
        })
        ol.appendChild(li)
      })
      box.appendChild(ol)
    }
    return box
  }

  var SVGNS = 'http://www.w3.org/2000/svg'
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag)
    for (var key in attrs) if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key])
    return node
  }

  // A two-series line over the range. Drawn by hand because a chart library
  // would be the single heaviest thing on this site, for one chart.
  function lineChart(series, keys) {
    var W = 1000, H = 190, PAD = 26
    var svg = svgEl('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img' })
    svg.appendChild(svgEl('title', {})).textContent =
      keys.map(function (k) { return k.label }).join(' and ') + ' per day'

    var top = 1
    series.forEach(function (point) {
      keys.forEach(function (k) { top = Math.max(top, point[k.field] || 0) })
    })
    // Round the ceiling up so the axis reads in whole numbers.
    var step = Math.pow(10, Math.max(0, String(Math.round(top)).length - 2))
    top = Math.ceil(top / step) * step || 1

    var x = function (i) { return PAD + (i * (W - PAD * 2)) / Math.max(1, series.length - 1) }
    var y = function (v) { return H - PAD - ((v || 0) / top) * (H - PAD * 2) }

    ;[0, 0.5, 1].forEach(function (fraction) {
      var gy = H - PAD - fraction * (H - PAD * 2)
      svg.appendChild(svgEl('line', { class: 'chart-grid', x1: PAD, x2: W - PAD, y1: gy, y2: gy }))
      var label = svgEl('text', { class: 'chart-tick', x: 0, y: gy + 3.5 })
      label.textContent = n(top * fraction)
      svg.appendChild(label)
    })

    keys.forEach(function (key, index) {
      var d = series.map(function (point, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(point[key.field]) }).join(' ')
      if (!index) {
        svg.appendChild(svgEl('path', {
          class: 'chart-area',
          d: d + ' L' + x(series.length - 1) + ' ' + (H - PAD) + ' L' + x(0) + ' ' + (H - PAD) + ' Z'
        }))
      }
      svg.appendChild(svgEl('path', { class: index ? 'chart-line-2' : 'chart-line', d: d }))
    })

    var wrap = el('div')
    wrap.appendChild(svg)
    var axis = el('div', 'hours-axis')
    axis.appendChild(el('span', null, series[0] ? series[0].date : ''))
    axis.appendChild(el('span', null, series.length ? series[series.length - 1].date : ''))
    wrap.appendChild(axis)

    var key = el('div', 'chart-key')
    keys.forEach(function (k, i) {
      var item = el('span')
      var swatch = el('i')
      swatch.style.background = i ? 'var(--dusk)' : 'var(--sage)'
      item.appendChild(swatch)
      item.appendChild(document.createTextNode(k.label))
      key.appendChild(item)
    })
    wrap.appendChild(key)
    return wrap
  }

  function scoreRing(score) {
    var size = 92, r = 38, c = 2 * Math.PI * r
    var svg = svgEl('svg', { class: 'score-ring', width: size, height: size, viewBox: '0 0 ' + size + ' ' + size })
    svg.appendChild(svgEl('circle', {
      cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: 'var(--hairline)', 'stroke-width': 7
    }))
    svg.appendChild(svgEl('circle', {
      cx: size / 2, cy: size / 2, r: r, fill: 'none',
      stroke: score >= 85 ? 'var(--sage)' : score >= 65 ? 'var(--dusk)' : '#A85A5A',
      'stroke-width': 7, 'stroke-linecap': 'round',
      'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - score / 100),
      transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'
    }))
    var text = svgEl('text', {
      x: size / 2, y: size / 2 + 7, 'text-anchor': 'middle',
      'font-size': 24, 'font-weight': 300, fill: 'var(--seal)'
    })
    text.textContent = String(score)
    svg.appendChild(text)
    return svg
  }

  // ------------------------------------------------------------- traffic

  var CHANNEL_NAMES = {
    organic: 'Search',
    ai: 'AI assistants',
    social: 'Social',
    referral: 'Other sites',
    direct: 'Direct / unknown',
    internal: 'Within the site'
  }

  function drawTraffic(panel) {
    clear(panel)
    var t = data.traffic

    if (t.error) { panel.appendChild(empty('The counters could not be read', t.error)); return }

    if (!t.measuring) {
      panel.appendChild(empty(
        'Nothing measured yet',
        [
          'No visits have been recorded. That is either because the beacon has not been deployed to the public pages yet, or because nobody has been to the site since it was.',
          'This is deliberately not a zero on a chart. A zero would mean nobody came; this means nothing has been counted, and those are different things to act on.'
        ],
        [
          'Check that `/assets/measure.js` is loaded by the public pages.',
          'Check that `/api/measure` answers a POST — it returns 204 with no body, which is correct.',
          'Visits from `localhost`, from `/admin/`, and from this browser are never counted.'
        ]
      ))
      return
    }

    var totals = t.totals

    var row = el('div', 'stat-row')
    row.appendChild(stat('Page views', n(totals.views), null, t.change.views))
    row.appendChild(stat('Visitors', n(totals.visitors), null, t.change.visitors))
    row.appendChild(stat('Visits', n(totals.sessions), null, t.change.sessions))
    row.appendChild(stat('Pages per visit', totals.pagesPerSession.toFixed(2), null, null, 'views ÷ visits'))
    row.appendChild(stat('Time on page', seconds(totals.avgSeconds), null, null,
      totals.dwellSamples ? n(totals.dwellSamples) + ' measured' : 'not yet measured'))
    row.appendChild(stat('Single-page visits', totals.bounceRate + '%', null, t.change.bounceRate))
    panel.appendChild(row)

    var trend = block('Over the last ' + t.window.days + ' days', t.window.from + ' to ' + t.window.to)
    var card = el('div', 'p-card')
    card.appendChild(lineChart(totals.series, [
      { field: 'views', label: 'Page views' },
      { field: 'visitors', label: 'Visitors' }
    ]))
    trend.appendChild(card)
    panel.appendChild(trend)

    var where = block('Where they came from', 'Counted once per visit, at the page they arrived on')
    var split = el('div', 'split')

    var channels = el('div', 'p-card')
    channels.appendChild(el('div', 'stat-label', 'Channel'))
    // These add up to visits, not views — see the note on the heading.

    channels.appendChild(barList(
      t.channels.map(function (c) { return { label: CHANNEL_NAMES[c.name] || c.name, count: c.count } }),
      null
    ))
    split.appendChild(channels)

    var refs = el('div', 'p-card')
    refs.appendChild(el('div', 'stat-label', 'Referring site'))
    if (t.referrers.length) refs.appendChild(barList(t.referrers, 'dusk'))
    else refs.appendChild(el('p', 'find-why', 'Every visit so far arrived without a referrer — typed in, bookmarked, or from an app that strips it.'))
    split.appendChild(refs)

    where.appendChild(split)
    panel.appendChild(where)

    var pages = block('Pages', 'Top ' + t.pages.length + ' by views')
    pages.appendChild(table(
      [
        { label: 'Page' },
        { label: 'Views', num: true },
        { label: 'Entered here', num: true },
        { label: 'Left here', num: true },
        { label: 'Time on page', num: true }
      ],
      t.pages.map(function (p) {
        return [pathCell(p.path), n(p.views), n(p.entries), n(p.exits), p.avgSeconds ? seconds(p.avgSeconds) : '—']
      })
    ))
    panel.appendChild(pages)

    var who = block('Who they are')
    var whoSplit = el('div', 'split')
    ;[
      ['Device', t.devices, null],
      ['Browser', t.browsers, null],
      ['System', t.systems, null],
      ['Country', t.countries.map(function (c) { return { label: country(c.name), count: c.count } }), 'dusk']
    ].forEach(function (pair) {
      var box = el('div', 'p-card')
      box.appendChild(el('div', 'stat-label', pair[0]))
      if (pair[1].length) box.appendChild(barList(pair[1], pair[2]))
      else box.appendChild(el('p', 'find-why', 'Nothing recorded yet.'))
      whoSplit.appendChild(box)
    })
    who.appendChild(whoSplit)
    panel.appendChild(who)

    var rhythm = block('When they come', 'By hour, UTC')
    var hourCard = el('div', 'p-card')
    var top = t.hours.reduce(function (m, v) { return Math.max(m, v) }, 0) || 1
    var strip = el('div', 'hours')
    t.hours.forEach(function (count, hour) {
      var bar = el('span')
      bar.style.height = Math.max(3, (count / top) * 100) + '%'
      bar.title = hour + ':00 — ' + n(count) + ' views'
      if (count === top) bar.style.background = 'var(--sage)'
      strip.appendChild(bar)
    })
    hourCard.appendChild(strip)
    var axis = el('div', 'hours-axis')
    ;['00:00', '06:00', '12:00', '18:00', '23:00'].forEach(function (label) { axis.appendChild(el('span', null, label)) })
    hourCard.appendChild(axis)
    hourCard.appendChild(el('p', 'find-why', 'Average scroll depth across every view: ' + t.avgScroll + '% of the page.'))
    rhythm.appendChild(hourCard)
    panel.appendChild(rhythm)

    var journey = block('How visits start and end')
    var jSplit = el('div', 'split')
    var landings = el('div', 'p-card')
    landings.appendChild(el('div', 'stat-label', 'First page of a visit'))
    landings.appendChild(t.landings.length ? barList(t.landings) : el('p', 'find-why', 'Nothing recorded yet.'))
    jSplit.appendChild(landings)
    var exits = el('div', 'p-card')
    exits.appendChild(el('div', 'stat-label', 'Last page of a visit'))
    exits.appendChild(t.exits.length ? barList(t.exits, 'dusk') : el('p', 'find-why', 'Nothing recorded yet — this arrives from the beacon sent as a page closes, which some browsers drop.'))
    jSplit.appendChild(exits)
    journey.appendChild(jSplit)
    panel.appendChild(journey)
  }

  // -------------------------------------------------------------- search

  var SETUP_STEPS = [
    'Google Cloud Console → create a project → APIs & Services → enable the `Google Search Console API`.',
    'Credentials → Create credentials → Service account. Give it no roles — it needs none.',
    'On the service account → Keys → Add key → JSON. Download it.',
    'Search Console → your property → Settings → Users and permissions → Add user → paste the service account email → Full or Restricted. This step is the one everyone misses, and without it the key works and every read returns 403.',
    'Netlify → Environment variables → add `GOOGLE_SERVICE_ACCOUNT_JSON` with the whole key file pasted in as one value.',
    'Add `GSC_SITE_URL` — `sc-domain:createspacebrand.com` for a domain property, or the exact URL prefix if that is how it was verified.',
    'Trigger a deploy, then reload this page.'
  ]

  var STANDING = {
    winning: { label: 'Winning', tone: 'good', note: 'top 3' },
    working: { label: 'Working', tone: 'good', note: 'page one' },
    competing: { label: 'Competing', tone: 'watch', note: 'page two' },
    emerging: { label: 'Emerging', tone: 'quiet', note: 'pages three to five' },
    distant: { label: 'Distant', tone: 'quiet', note: 'past position 50' }
  }

  function drawSearch(panel) {
    clear(panel)
    var s = data.search

    if (!s.connected) {
      var why = {
        'no-credentials': 'No Google service account is configured, so there is nothing to ask.',
        'bad-key': 'A service account is configured but the private key is malformed — usually the newlines. If it was pasted as one line, set GSC_PRIVATE_KEY with literal \\n between lines, or paste the whole key file into GOOGLE_SERVICE_ACCOUNT_JSON instead.',
        'not-shared': 'The key works, but the service account is not a user on ' + (s.property || 'the property') + '. Add it in Search Console → Settings → Users and permissions.',
        'no-property': 'Google has no property called ' + (s.property || '—') + '. Check GSC_SITE_URL matches exactly how the site was verified.',
        'no-token': 'Google refused the signed assertion. Check the service account still exists and the key has not been revoked.',
        unreachable: 'Google could not be reached just now. This is usually temporary.'
      }[s.reason] || 'Search Console is not connected.'

      panel.appendChild(empty(
        'Search Console is not connected',
        [
          why,
          'Impressions, clicks and average position are measurements of Google’s own index. Nothing on this side can stand in for them, so this panel stays empty rather than showing a number that was invented here.'
        ],
        SETUP_STEPS
      ))
      return
    }

    var totals = s.totals
    var prior = s.prior
    var row = el('div', 'stat-row')
    row.appendChild(stat('Clicks', n(totals.clicks), null, {
      direction: totals.clicks > prior.clicks ? 'up' : totals.clicks < prior.clicks ? 'down' : 'flat',
      percent: prior.clicks ? Math.round(((totals.clicks - prior.clicks) / prior.clicks) * 100) : null
    }))
    row.appendChild(stat('Impressions', n(totals.impressions), null, {
      direction: totals.impressions > prior.impressions ? 'up' : totals.impressions < prior.impressions ? 'down' : 'flat',
      percent: prior.impressions ? Math.round(((totals.impressions - prior.impressions) / prior.impressions) * 100) : null
    }))
    row.appendChild(stat('Click-through', pct(totals.ctr), null, null, 'of everyone who saw a listing'))
    row.appendChild(stat('Average position', totals.position ? totals.position.toFixed(1) : '—', null, null,
      totals.position ? (totals.position <= 10 ? 'page one' : 'page ' + Math.ceil(totals.position / 10)) : ''))
    row.appendChild(stat('Terms ranking', n(s.keywords.length), null, null, 'with at least one impression'))
    panel.appendChild(row)

    var note = block('Where the terms stand',
      s.window.startDate + ' to ' + s.window.endDate + ' · Search Console reports ' + s.window.lagDays + ' days behind, always')
    var standings = el('div', 'p-card')
    var order = ['winning', 'working', 'competing', 'emerging', 'distant']
    standings.appendChild(barList(
      order.filter(function (k) { return s.byStanding[k] }).map(function (k) {
        return { label: STANDING[k].label + ' — ' + STANDING[k].note, count: s.byStanding[k] }
      })
    ))
    note.appendChild(standings)
    panel.appendChild(note)

    if (s.series.length > 1) {
      var trend = block('Clicks and impressions per day')
      var card = el('div', 'p-card')
      card.appendChild(lineChart(s.series, [
        { field: 'impressions', label: 'Impressions' },
        { field: 'clicks', label: 'Clicks' }
      ]))
      trend.appendChild(card)
      panel.appendChild(trend)
    }

    var terms = block('Every term the site is showing up for', 'Sorted by impressions · ' + n(s.keywords.length) + ' terms')
    terms.appendChild(table(
      [
        { label: 'Term' },
        { label: 'Standing' },
        { label: 'Position', num: true },
        { label: 'Impressions', num: true },
        { label: 'Clicks', num: true },
        { label: 'CTR', num: true }
      ],
      s.keywords.slice(0, 150).map(function (k) {
        var standing = STANDING[k.standing]
        var mark = pill(standing.label, standing.tone)
        if (k.underClicked) mark.title = 'Ranking well and being scrolled past — a title problem, not a ranking one.'
        if (k.withinReach) mark.title = 'Page two, with real demand behind it — the cheapest place to gain.'
        return [k.term, mark, k.position.toFixed(1), n(k.impressions), n(k.clicks), pct(k.ctr)]
      })
    ))
    if (s.keywords.length > 150) {
      terms.appendChild(el('p', 'find-why', 'Showing the first 150 of ' + n(s.keywords.length) + '.'))
    }
    panel.appendChild(terms)

    if (s.pages.length) {
      var pages = block('Pages earning the impressions')
      pages.appendChild(table(
        [
          { label: 'Page' },
          { label: 'Position', num: true },
          { label: 'Impressions', num: true },
          { label: 'Clicks', num: true },
          { label: 'CTR', num: true }
        ],
        s.pages.slice(0, 40).map(function (p) {
          var path = p.url
          try { path = new URL(p.url).pathname } catch (e) { /* keep the raw value */ }
          return [pathCell(path), p.position.toFixed(1), n(p.impressions), n(p.clicks), pct(p.ctr)]
        })
      ))
      panel.appendChild(pages)
    }
  }

  // --------------------------------------------------------- suggestions

  var IMPACT = { high: 'bad', medium: 'watch', low: 'quiet' }

  function finding(item) {
    var box = el('details', 'find')
    var head = el('summary')
    head.appendChild(pill(item.impact + ' impact', IMPACT[item.impact]))
    head.appendChild(el('span', 'find-title', item.title))
    if (item.where && item.where.length) {
      head.appendChild(el('span', 'find-count', item.where.length + (item.where.length === 1 ? ' place' : ' places')))
    }
    head.appendChild(pill(item.effort, 'quiet'))
    box.appendChild(head)

    var body = el('div', 'find-body')
    body.appendChild(el('p', 'find-why', item.why))
    var steps = el('ol', 'find-do')
    item.do.forEach(function (step) { steps.appendChild(el('li', null, step)) })
    body.appendChild(steps)

    if (item.evidence && item.evidence.length) {
      var ev = el('ul', 'find-evidence')
      item.evidence.forEach(function (line) { ev.appendChild(el('li', null, line)) })
      body.appendChild(ev)
    }
    if (item.where && item.where.length) {
      var where = el('div', 'find-where')
      item.where.forEach(function (place) { where.appendChild(el('code', null, place)) })
      body.appendChild(where)
    }
    box.appendChild(body)
    return box
  }

  function drawSuggestions(panel) {
    clear(panel)
    var audit = data.audit
    var play = data.playbook

    // ---- the health of the site, as crawled
    var health = block('Site health',
      audit.at ? 'Crawled ' + when(audit.at) + (audit.cached ? ' · cached; Refresh re-crawls' : '') : '')
    var healthCard = el('div', 'p-card')

    if (audit.error) {
      healthCard.appendChild(el('p', 'find-why', audit.error))
    } else {
      var wrap = el('div', 'score-wrap')
      wrap.appendChild(scoreRing(audit.summary.score))
      var side = el('div')
      side.appendChild(el('div', 'stat-label', 'Average page score'))
      side.appendChild(el('p', 'find-why',
        audit.summary.crawled + ' pages crawled, ' + audit.summary.indexable + ' of them indexable. ' +
        audit.summary.critical + ' critical, ' + audit.summary.warnings + ' warnings, ' + audit.summary.notes + ' notes. ' +
        (audit.summary.clean ? audit.summary.clean + ' pages came back clean.' : 'No page came back completely clean.')))
      side.appendChild(el('p', 'find-why',
        'Every page starts at 100 and pays for what is wrong with it — 18 for something critical, 8 for a warning, 3 for a note. It is this site grading itself against the checks below, not a number from Google.'))
      wrap.appendChild(side)
      healthCard.appendChild(wrap)
    }
    health.appendChild(healthCard)
    panel.appendChild(health)

    // ---- computed findings
    var found = block('What to fix',
      play.counts.findings + ' findings · ' + play.counts.high + ' high impact · every one measured, not assumed')
    if (!play.findings.length) {
      found.appendChild(empty('Nothing outstanding', 'Every check this portal runs came back clean. That is rarer than it sounds — re-run it after the next content change.'))
    } else {
      play.findings.forEach(function (item) { found.appendChild(finding(item)) })
    }
    panel.appendChild(found)

    // ---- the keyword strategy
    var kw = block('Keywords to go after', 'Editorial judgement about this business — not a measurement')
    var intro = el('div', 'p-card')
    intro.appendChild(el('p', 'find-why',
      data.search.connected
        ? 'The Search tab shows what the site actually ranks for today. This is the map of what it should be trying to rank for, grouped by the job the searcher is doing — because the job decides which page answers and what that page has to say. Terms already ranking are marked.'
        : 'These are the terms this site should be trying to own, grouped by the job the searcher is doing. No search volumes are shown, because nothing here can measure one — connect Search Console on the Search tab and the terms already ranking will be marked here.'))
    kw.appendChild(intro)

    var ranking = {}
    if (data.search.connected) {
      data.search.keywords.forEach(function (k) { ranking[k.term.toLowerCase()] = k })
    }

    var clusters = el('div')
    clusters.style.display = 'grid'
    clusters.style.gap = '12px'
    clusters.style.marginTop = '12px'

    play.keywords.forEach(function (cluster) {
      var box = el('div', 'cluster')
      var head = el('div', 'cluster-head')
      head.appendChild(el('span', 'cluster-name', cluster.cluster))
      head.appendChild(pill(cluster.intent, cluster.intent.indexOf('commercial') === 0 ? 'watch' : 'quiet'))
      head.appendChild(el('span', 'cluster-page', cluster.page || 'no page for this yet'))
      box.appendChild(head)
      box.appendChild(el('p', 'cluster-why', cluster.why))

      var terms = el('div', 'cluster-terms')
      cluster.terms.forEach(function (term) {
        var hit = ranking[term.toLowerCase()]
        var chip = el('span', 'term', hit ? term + ' · #' + hit.position.toFixed(0) : term)
        if (hit) {
          chip.dataset.standing = hit.standing
          chip.title = hit.impressions + ' impressions, ' + hit.clicks + ' clicks in the last window'
        }
        terms.appendChild(chip)
      })
      box.appendChild(terms)

      var move = el('div', 'cluster-move')
      move.appendChild(el('b', null, 'The move: '))
      move.appendChild(document.createTextNode(cluster.move))
      box.appendChild(move)
      clusters.appendChild(box)
    })
    kw.appendChild(clusters)
    panel.appendChild(kw)

    // ---- structural moves
    var structure = block('Formatting and structure', 'The things a crawl cannot find, because they are about what is not there')
    play.structural.forEach(function (item) {
      structure.appendChild(finding({
        impact: item.impact,
        title: item.title,
        effort: item.effort,
        why: item.why,
        do: item.do,
        where: []
      }))
    })
    panel.appendChild(structure)

    // ---- the page-by-page crawl
    if (!audit.error && audit.pages.length) {
      var perPage = block('Every page, as a crawler sees it')
      perPage.appendChild(table(
        [
          { label: 'Page' },
          { label: 'Score', num: true },
          { label: 'Title', num: true },
          { label: 'Description', num: true },
          { label: 'H1', num: true },
          { label: 'Words', num: true },
          { label: 'Links', num: true },
          { label: 'Schema' },
          { label: 'Issues', num: true }
        ],
        audit.pages.map(function (p) {
          return [
            pathCell(p.path),
            p.noindex ? pill('noindex', 'quiet') : String(p.score),
            p.noindex ? '—' : p.titleLength,
            p.noindex ? '—' : p.descriptionLength,
            p.noindex ? '—' : p.h1,
            p.noindex ? '—' : n(p.words),
            p.noindex ? '—' : p.internalLinks,
            p.schemaTypes && p.schemaTypes.length ? p.schemaTypes.join(', ') : '—',
            p.noindex ? '—' : p.issues.length
          ]
        })
      ))
      // Only worth explaining if one is actually in the table. The sitemap
      // does not list the noindex pages, so usually none is.
      if (audit.pages.some(function (p) { return p.noindex })) {
        perPage.appendChild(el('p', 'find-why',
          'A noindex page is crawled to confirm it still says noindex, and then left alone. A missing description on a page nobody should find is correct, not a fault.'))
      } else {
        perPage.appendChild(el('p', 'find-why',
          'These are the pages sitemap.xml lists — the ones the site has asked Google to care about. The checkout, the order page, the stockroom and this portal are noindex and deliberately absent from it.'))
      }
      panel.appendChild(perPage)
    }
  }

  // ---------------------------------------------------------------- draw

  function draw() {
    drawTraffic(room.querySelector('[data-panel="traffic"]'))
    drawSearch(room.querySelector('[data-panel="search"]'))
    drawSuggestions(room.querySelector('[data-panel="suggestions"]'))

    var live = room.querySelector('[data-live]')
    if (data.traffic && data.traffic.live && data.traffic.live.views) {
      live.textContent = data.traffic.live.views + ' in the last ' + data.traffic.live.minutes + ' min'
      live.setAttribute('data-on', '')
    } else {
      live.removeAttribute('data-on')
    }

    room.querySelector('[data-stamp]').textContent =
      'Read ' + when(data.generatedAt) + ' · signed in until ' + when(data.sessionExpiresAt)
  }

  // --------------------------------------------------------------- start

  api('/api/admin-auth')
    .then(function (body) {
      if (body.signedIn) { showRoom(); return load() }
      showGate(body.door)
    })
    .catch(function () {
      showGate()
      say(gateError, 'The portal could not be reached. If this is a local preview, the functions need `netlify dev` rather than a static server.')
    })
})()
