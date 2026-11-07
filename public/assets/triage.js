// /triage/ — the triage line. An open line: a question in, an answer with its
// sources out, and a person one word away.
//
// Everything that decides lives in the workspace (shared/triageCore.mjs and
// the bank in shared/triage/); this page is a thin hand. It reads the bank's
// questions once (/api/triage-bank) so it can suggest what the line already
// knows as you type, sends each ask to /api/triage, and runs the live line
// through /api/triage-line by a token it keeps in this browser and in the
// address bar (?line=…), so a thread survives a reload and a reply can find
// its way back. When the workspace does not answer, the page says so and
// keeps the one thing that matters: a way to leave the question with a person.
// Nothing here names a mailbox or a secret.

const root = document.querySelector('[data-tl]')
const TOKEN_KEY = 'cs.triage.line'
const POLL_MS = 4000

function boot() {
  if (!root) return
  const $ = (sel) => root.querySelector(sel)
  const ask = $('[data-tl-ask]')
  const askBtn = $('[data-tl-send]')
  const chips = $('[data-tl-topics]')
  const suggest = $('[data-tl-suggest]')
  const suggestList = $('[data-tl-suggest-list]')
  const answer = $('[data-tl-answer]')
  const thread = $('[data-tl-thread]')
  const errorLine = $('[data-tl-error]')
  const hp = $('[data-tl-hp]')
  const topicsGrid = document.querySelector('[data-tl-topic-cards]')
  const stamp = document.querySelector('[data-tl-stamp]')
  const hoursEls = document.querySelectorAll('[data-tl-hours]')

  const state = { bank: null, topic: '', openedAt: Date.now(), token: null, line: null, lastAt: null, timer: null, busy: false }

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid)
    return el
  }
  const say = (msg) => { errorLine.textContent = msg || ''; errorLine.hidden = !msg }
  const year = (d) => String(d || '').slice(0, 4)
  const setHours = (line) => { if (line) hoursEls.forEach((el) => { el.textContent = line }) }

  /* ── the bank: the questions the line knows ─────────────────────────── */
  async function loadBank() {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch('/api/triage-bank', { signal: ctrl.signal, headers: { accept: 'application/json' } })
      clearTimeout(timer)
      if (!res.ok) throw new Error(String(res.status))
      state.bank = await res.json()
      if (stamp) stamp.textContent = state.bank.stamp
      setHours(state.bank.hours)
      paintTopics()
      return true
    } catch {
      state.bank = null
      return false
    }
  }

  const topicName = (key) => { const t = state.bank && state.bank.topics.find((x) => x.key === key); return t ? t.short : key }

  function paintTopics() {
    if (!state.bank) return
    chips.innerHTML = ''
    for (const t of state.bank.topics) {
      chips.append(h('button', { type: 'button', class: 'tl-chip' + (state.topic === t.key ? ' is-on' : ''), 'data-topic': t.key, title: t.ask, onclick: () => pickTopic(t.key) }, t.short))
    }
    if (topicsGrid) {
      topicsGrid.innerHTML = ''
      for (const t of state.bank.topics) {
        const qs = state.bank.entries.filter((e) => e.topic === t.key).slice(0, 3)
        topicsGrid.append(h('article', { class: 'tl-topic' },
          h('h3', {}, t.name, h('small', { text: `${t.count} answers` })),
          h('p', { text: t.ask }),
          h('ul', { class: 'tl-topic-qs' }, qs.map((e) => h('li', {}, h('button', { type: 'button', onclick: () => { ask.value = e.q; state.topic = t.key; paintTopics(); root.scrollIntoView({ behavior: 'smooth', block: 'start' }); send() } }, e.q)))),
        ))
      }
    }
  }
  function pickTopic(key) {
    state.topic = state.topic === key ? '' : key
    paintTopics()
    suggestFor(ask.value)
  }

  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
  function suggestFor(q) {
    if (!state.bank) { suggest.hidden = true; return }
    const ws = words(q)
    let rows = []
    if (ws.length) {
      rows = state.bank.entries
        .map((e) => { const hay = (e.q + ' ' + e.asks.join(' ') + ' ' + e.tags.join(' ')).toLowerCase(); let n = 0; for (const w of ws) if (hay.includes(w)) n += 1; return { e, n } })
        .filter((r) => r.n > 0 && (!state.topic || r.e.topic === state.topic))
        .sort((a, b) => b.n - a.n)
        .slice(0, 4)
        .map((r) => r.e)
    } else if (state.topic) {
      rows = state.bank.entries.filter((e) => e.topic === state.topic).slice(0, 4)
    }
    suggestList.innerHTML = ''
    for (const e of rows) suggestList.append(h('button', { type: 'button', class: 'tl-chip tl-chip-q', onclick: () => { ask.value = e.q; send() } }, e.q))
    suggest.hidden = rows.length === 0
  }

  /* ── one ask ─────────────────────────────────────────────────────────── */
  async function send() {
    const q = ask.value.trim()
    if (q.length < 3) { say('Ask the question first — a few words are enough.'); ask.focus(); return }
    if (state.busy) return
    say('')
    state.busy = true
    askBtn.disabled = true
    askBtn.textContent = 'Reading…'
    try {
      // On an open thread, the question goes to the thread; otherwise it is one ask.
      if (state.token && state.line && state.line.state !== 'closed') { await sayOnLine(q); ask.value = ''; return }
      const res = await fetch('/api/triage', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ question: q, topic: state.topic || null, website: hp.value, elapsedMs: Date.now() - state.openedAt }) })
      const data = await res.json().catch(() => ({}))
      // A 4xx is the door's own word to the visitor; a 5xx is the house being away, and the page says that in its own words.
      if (res.status >= 500) { say('The line is quiet right now — the house could not be reached. You can leave the question with a person below.'); quietLine(q); return }
      if (!res.ok) { say(data.error || 'The line could not answer just now. Try once more, or reach a person below.'); return }
      renderAnswer(q, data)
      suggest.hidden = true
    } catch {
      say('The line is quiet right now — it could not be reached. You can still leave the question with a person below.')
      quietLine(q)
    } finally {
      state.busy = false
      askBtn.disabled = false
      askBtn.textContent = state.token && state.line && state.line.state !== 'closed' ? 'Send' : 'Ask the line'
    }
  }

  function sourcesBlock(list) {
    if (!list || !list.length) return null
    return h('div', { class: 'tl-sources' },
      h('span', { class: 'tl-label', text: 'Read from' }),
      list.map((s) => h('div', { class: 'tl-source' },
        h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, `${s.publisher} — ${s.title}`),
        h('small', { text: `${year(s.date)}${s.kindLabel ? ' · ' + s.kindLabel : ''}` }),
      )),
    )
  }
  const STAGE = { starting: 'starting out', growing: 'growing', established: 'established' }
  function readingTags(r) {
    const tags = []
    if (r.topic) tags.push(h('span', { class: 'tl-tag is-sage', text: topicName(r.topic) }))
    if (r.stage && STAGE[r.stage]) tags.push(h('span', { class: 'tl-tag', text: STAGE[r.stage] }))
    if (r.urgency === 'now') tags.push(h('span', { class: 'tl-tag is-dusk', text: 'pressing' }))
    if (r.confidence === 'offer') tags.push(h('span', { class: 'tl-tag', text: 'the closest the line knows' }))
    return tags
  }

  function renderAnswer(q, data) {
    thread.hidden = true
    answer.innerHTML = ''
    answer.hidden = false
    const a = data.answer || {}
    const r = data.reading || {}
    setHours(r.hours)
    answer.append(h('p', { class: 'tl-q', text: q }))
    const tags = readingTags(r)
    if (tags.length) answer.append(h('div', { class: 'tl-reading' }, tags))
    answer.append(h('p', { class: 'tl-text' + (a.kind === 'offer' ? ' is-offer' : ''), text: a.text || '' }))
    const src = sourcesBlock(a.sources)
    if (src) answer.append(src)
    if (a.related && a.related.length) {
      answer.append(h('div', { class: 'tl-related' },
        h('span', { class: 'tl-label', text: 'People also ask' }),
        h('div', { class: 'tl-chips' }, a.related.map((e) => h('button', { type: 'button', class: 'tl-chip tl-chip-q', onclick: () => { ask.value = e.q; send() } }, e.q))),
      ))
    }
    answer.append(handPanel(q, a, r))
    answer.append(h('p', { class: 'tl-status', text: (r.open ? 'A person is on the line now. ' : '') + 'Ask another question above, or hand this one to a person. Nothing here is legal, tax or financial advice.' }))
    answer.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /* ── a person ────────────────────────────────────────────────────────── */
  function handPanel(q, a, r) {
    const why = (a.handWhy || [])
    const panel = h('div', { class: 'tl-hand' })
    panel.append(h('h3', { text: a.hand ? 'This one is worth a person’s eyes.' : 'Want a person on it?' }))
    if (why.length) panel.append(h('div', { class: 'tl-hand-why' }, why.map((w) => h('span', { class: 'tl-tag is-dusk', text: w }))))
    panel.append(h('p', { text: (a.hand ? 'The line answered the general picture; the specifics of your own situation are yours, and someone on the team can read them with you. ' : 'Say so and the thread goes to someone on the team. ') + (r.hours || '') }))
    const name = h('input', { type: 'text', name: 'name', placeholder: 'Your name', autocomplete: 'name', maxlength: '120' })
    const email = h('input', { type: 'email', name: 'email', placeholder: 'you@studio.com', autocomplete: 'email', maxlength: '200' })
    const handle = h('input', { type: 'text', name: 'handle', placeholder: '@handle (optional)', maxlength: '60' })
    panel.append(h('div', { class: 'tl-fields' },
      h('label', { class: 'tl-field' }, h('span', { text: 'Name' }), name),
      h('label', { class: 'tl-field' }, h('span', { text: 'Email' }), email),
      h('label', { class: 'tl-field' }, h('span', { text: 'Handle' }), handle),
    ))
    const btn = h('button', { type: 'button', class: 'tl-btn', onclick: () => openLine({ question: q, name: name.value, email: email.value, handle: handle.value, person: true }, btn) }, 'Hand me to a person')
    panel.append(h('div', { class: 'tl-row' }, btn, h('p', { class: 'tl-fine', text: 'The email is used only to answer you if you have gone by the time a person replies. No list, no tracking.' })))
    return panel
  }

  async function openLine({ question, name, email, handle, person }, btn) {
    if (state.busy) return
    say('')
    state.busy = true
    if (btn) { btn.disabled = true; btn.textContent = 'Opening the line…' }
    try {
      const res = await fetch('/api/triage-line', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ act: 'open', question: person ? `${question}\n\nPlease hand me to a person.` : question, name, email, handle, topic: state.topic || null, website: hp.value }) })
      const data = await res.json().catch(() => ({}))
      if (res.status >= 500) { say('The line is quiet right now — the house could not be reached. Leave the question below and a person will answer by email.'); quietLine(question, { name, email }); return }
      if (!res.ok) { say(data.error || 'The line could not open just now.'); return }
      state.token = data.token
      state.line = data
      try { localStorage.setItem(TOKEN_KEY, data.token) } catch { /* private window */ }
      const url = new URL(window.location.href); url.searchParams.set('line', data.token); history.replaceState(null, '', url)
      // The first message was the general answer; a visitor who asked for a person goes straight to waiting.
      if (person && data.state !== 'waiting' && data.state !== 'person') await sayOnLine('Yes — a person, please.')
      else renderThread(data)
      startPolling()
    } catch {
      say('The line is quiet right now — it could not be reached. Leave the question below and a person will answer by email.')
      quietLine(question, { name, email })
    } finally {
      state.busy = false
      if (btn) { btn.disabled = false; btn.textContent = 'Hand me to a person' }
    }
  }

  async function sayOnLine(text) {
    const res = await fetch('/api/triage-line', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ act: 'say', token: state.token, text, website: hp.value }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { say(res.status >= 500 ? 'The line dropped that — the house could not be reached. Try once more in a moment.' : (data.error || 'That did not send. Try once more.')); if (res.status === 404) forget(); return }
    state.line = data
    renderThread(data)
  }

  function forget() {
    state.token = null; state.line = null
    try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
    const url = new URL(window.location.href); url.searchParams.delete('line'); history.replaceState(null, '', url)
    stopPolling()
    thread.hidden = true
    askBtn.textContent = 'Ask the line'
  }

  async function poll() {
    if (!state.token) return
    try {
      const res = await fetch(`/api/triage-line?token=${encodeURIComponent(state.token)}`, { headers: { accept: 'application/json' } })
      if (res.status === 404) { forget(); return }
      if (!res.ok) return
      const data = await res.json()
      const before = state.line ? JSON.stringify([state.line.state, state.line.messages.length]) : ''
      state.line = data
      if (JSON.stringify([data.state, data.messages.length]) !== before) renderThread(data)
    } catch { /* the next tick */ }
  }
  function startPolling() { stopPolling(); state.timer = setInterval(poll, POLL_MS); document.addEventListener('visibilitychange', onVisible) }
  function stopPolling() { if (state.timer) clearInterval(state.timer); state.timer = null; document.removeEventListener('visibilitychange', onVisible) }
  function onVisible() { if (document.visibilityState === 'visible') poll() }

  const STATE_LINE = {
    engine: 'With the line. Ask anything else, or say “a person” to hand the thread over.',
    waiting: 'Waiting on a person. Your thread is in front of the team; keep this page open, or leave — the reply also goes to your email if you gave one.',
    person: 'With a person on the team.',
    closed: 'This thread is closed. Reply and it opens again.',
  }
  function renderThread(data) {
    answer.hidden = true
    thread.innerHTML = ''
    thread.hidden = false
    setHours(data.hours)
    thread.append(h('div', { class: 'tl-thread-head' },
      h('span', { class: 'tl-state', 'data-state': data.state, text: data.stateLabel + (data.withRole && data.state === 'person' ? ` · ${data.withRole}` : '') }),
      h('button', { type: 'button', class: 'tl-btn tl-btn-ghost tl-btn-small', onclick: () => { forget(); answer.hidden = true; ask.value = ''; ask.focus() } }, 'Start a new question'),
    ))
    thread.append(h('p', { class: 'tl-status', text: STATE_LINE[data.state] || '' }))
    const list = h('div', { class: 'tl-msgs' })
    for (const m of data.messages || []) {
      const who = m.via === 'visitor' ? 'You' : m.via === 'person' ? (m.byRole || 'The team') : 'The line'
      const el = h('div', { class: 'tl-msg', 'data-via': m.via }, h('span', { class: 'tl-msg-who', text: who }), m.text)
      const src = sourcesBlock(m.sources)
      if (src) el.append(src)
      list.append(el)
    }
    thread.append(list)
    thread.append(h('p', { class: 'tl-fine', text: `Your thread lives at this address — keep the link to come back. ${data.hours || ''}` }))
    askBtn.textContent = 'Send'
    ask.placeholder = data.state === 'person' ? 'Write back…' : 'Ask another question, or say “a person” to hand the thread over…'
    const last = list.lastElementChild
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  /* ── the quiet line: leave it with a person ──────────────────────────── */
  function quietLine(question, prefill = {}) {
    thread.hidden = true
    answer.innerHTML = ''
    answer.hidden = false
    const name = h('input', { type: 'text', name: 'name', placeholder: 'Your name', autocomplete: 'name', value: prefill.name || '' })
    const email = h('input', { type: 'email', name: 'email', placeholder: 'you@studio.com', autocomplete: 'email', value: prefill.email || '' })
    const btn = h('button', { type: 'button', class: 'tl-btn' }, 'Leave it with a person')
    const panel = h('div', { class: 'tl-quiet' },
      h('h3', { text: 'The line is quiet right now.' }),
      h('p', { text: 'It could not reach the house. Leave the question and an address and a person will answer by email, usually within two working days.' }),
      h('div', { class: 'tl-fields' }, h('label', { class: 'tl-field' }, h('span', { text: 'Name' }), name), h('label', { class: 'tl-field' }, h('span', { text: 'Email' }), email)),
      h('p', { class: 'tl-q', text: question }),
      h('div', { class: 'tl-row' }, btn, h('a', { href: '/contact/', class: 'tl-fine', text: 'Or use the contact page' })),
    )
    btn.addEventListener('click', async () => {
      if (!email.value.trim()) { say('We need an email to answer to.'); return }
      btn.disabled = true
      try {
        const res = await fetch('/api/shop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'triage', name: name.value, email: email.value, question, website: hp.value, elapsedMs: Date.now() - state.openedAt }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || 'not sent')
        panel.innerHTML = ''
        panel.append(h('h3', { text: 'It’s with a person.' }), h('p', { text: `A reply goes to ${email.value.trim()} — usually within two working days.` }))
      } catch (e) {
        say(e.message || 'That did not send. The contact page is the other door.')
        btn.disabled = false
      }
    })
    answer.append(panel)
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */
  askBtn.addEventListener('click', send)
  ask.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() })
  let t = null
  ask.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => suggestFor(ask.value), 140) })

  loadBank().then(async (ok) => {
    const fromUrl = new URL(window.location.href).searchParams.get('line')
    let token = fromUrl
    if (!token) { try { token = localStorage.getItem(TOKEN_KEY) } catch { token = null } }
    if (token && /^[a-z0-9]{24}$/.test(token)) {
      state.token = token
      await poll()
      if (state.token) startPolling()
    }
    if (!ok && !state.token) say('The line could not reach the house just now; you can still ask, and if it stays quiet you can leave the question with a person.')
  })
}

boot()
