// /assessment/ — one question at a time, a card per answer, the fit at the end.
//
// Scores in the browser with the same file the desk scores with
// (assessment-core.mjs), so the result appears the moment the last answer is
// in; the desk re-scores the answers and never trusts a result it did not
// make. Nothing here names a mailbox or a secret.
import { QUESTIONS, SERVICE_COPY, score, servicePath } from './assessment-core.mjs'

const root = document.querySelector('[data-fit]')
const STASH = 'cs.fit.v1'

function boot() {
  if (!root) return
  const $ = (sel) => root.querySelector(sel)
  const dots = $('[data-fit-dots]')
  const count = $('[data-fit-count]')
  const qEl = $('[data-fit-q]')
  const ask = $('[data-fit-ask]')
  const opts = $('[data-fit-opts]')
  const back = $('[data-fit-back]')
  const contact = $('[data-fit-contact]')
  const result = $('[data-fit-result]')
  const errorLine = $('[data-fit-error]')
  const submit = contact.querySelector('button[type="submit"]')

  const state = { step: 0, answers: {}, openedAt: Date.now(), phase: 'ask' }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STASH) || 'null')
    if (saved && saved.answers) { state.answers = saved.answers; state.step = Math.min(Number(saved.step) || 0, QUESTIONS.length - 1) }
  } catch { /* a fresh start is fine */ }
  const stash = () => { try { sessionStorage.setItem(STASH, JSON.stringify({ step: state.step, answers: state.answers })) } catch { /* ignore */ } }

  /* ── the dots ─────────────────────────────────────────────────────────── */
  dots.innerHTML = ''
  for (let i = 0; i < QUESTIONS.length; i += 1) dots.appendChild(document.createElement('li'))
  function paintDots() {
    const answered = QUESTIONS.filter((q) => state.answers[q.id]).length
    Array.from(dots.children).forEach((li, i) => {
      li.className = state.phase === 'ask' && i === state.step ? 'is-now' : (i < answered || state.phase !== 'ask') ? 'is-done' : ''
    })
  }

  /* ── a question ───────────────────────────────────────────────────────── */
  const current = () => QUESTIONS[state.step]
  function renderQuestion() {
    const q = current()
    ask.textContent = q.ask
    opts.innerHTML = ''
    q.options.forEach((o, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'fit-opt' + (state.answers[q.id] === o.key ? ' is-picked' : '')
      b.setAttribute('data-key', o.key)
      const key = document.createElement('span'); key.className = 'fit-key'; key.textContent = String(i + 1)
      const text = document.createElement('span')
      const label = document.createElement('b'); label.textContent = o.label
      const small = document.createElement('small'); small.textContent = o.small
      text.appendChild(label); text.appendChild(small)
      b.appendChild(key); b.appendChild(text)
      b.addEventListener('click', () => pick(o.key))
      opts.appendChild(b)
    })
    back.hidden = state.step === 0
    count.textContent = `${state.step + 1} of ${QUESTIONS.length}`
    paintDots()
  }

  let moving = false
  function swap(render, dir) {
    if (moving) return
    moving = true
    qEl.classList.add(dir === 'back' ? 'is-arriving' : 'is-leaving')
    setTimeout(() => {
      render()
      qEl.classList.remove('is-leaving', 'is-arriving')
      qEl.classList.add(dir === 'back' ? 'is-leaving' : 'is-arriving')
      requestAnimationFrame(() => requestAnimationFrame(() => { qEl.classList.remove('is-leaving', 'is-arriving'); moving = false }))
    }, 220)
  }

  function pick(key) {
    if (moving) return
    const q = current()
    state.answers[q.id] = key
    stash()
    Array.from(opts.children).forEach((b) => b.classList.toggle('is-picked', b.getAttribute('data-key') === key))
    paintDots()
    setTimeout(next, 240)
  }
  function next() {
    if (state.step < QUESTIONS.length - 1) { state.step += 1; stash(); swap(renderQuestion, 'next') }
    else showContact()
  }
  function goBack() {
    if (state.phase === 'contact') { state.phase = 'ask'; contact.hidden = true; qEl.hidden = false; renderQuestion(); return }
    if (state.step === 0) return
    state.step -= 1; stash(); swap(renderQuestion, 'back')
  }
  back.addEventListener('click', goBack)
  $('[data-fit-contact-back]').addEventListener('click', goBack)

  document.addEventListener('keydown', (e) => {
    if (state.phase !== 'ask' || e.metaKey || e.ctrlKey || e.altKey) return
    const n = Number(e.key)
    const q = current()
    if (n >= 1 && n <= q.options.length) { e.preventDefault(); pick(q.options[n - 1].key) }
    else if (e.key === 'Backspace' && state.step > 0 && !(document.activeElement && /input|textarea/i.test(document.activeElement.tagName))) { e.preventDefault(); goBack() }
  })

  /* ── the last step ────────────────────────────────────────────────────── */
  function showContact() {
    state.phase = 'contact'
    qEl.hidden = true
    contact.hidden = false
    count.textContent = 'Last step'
    paintDots()
    const name = contact.querySelector('input[name="name"]')
    if (name && !name.value) name.focus({ preventScroll: true })
    contact.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const val = (name) => { const el = contact.elements[name]; return el && typeof el.value === 'string' ? el.value.trim() : '' }

  contact.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!contact.reportValidity()) return
    const local = score(state.answers)
    if (!local) { state.phase = 'ask'; contact.hidden = true; qEl.hidden = false; state.step = QUESTIONS.findIndex((q) => !state.answers[q.id]); renderQuestion(); return }

    errorLine.hidden = true
    submit.disabled = true
    submit.textContent = 'One moment…'
    const consent = contact.querySelector('input[name="consent"]').checked === true
    const email = val('email')

    // The fit is theirs the moment they press the button. The copy, the desk
    // and the list follow in the background, and the status line says how.
    showResult(local, { email, consent })

    fetch('/api/assessment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: val('name'), email, handle: val('handle'), consent, answers: state.answers, website: val('website'), elapsedMs: Date.now() - state.openedAt }),
    })
      .then((res) => res.json().catch(() => ({})).then((body) => {
        if (!res.ok) throw new Error(body.error || 'send-failed')
        setStatus(statusLine(body, { email, consent }))
        try { sessionStorage.removeItem(STASH) } catch { /* ignore */ }
      }))
      .catch((err) => {
        const own = err && err.message && err.message !== 'send-failed' ? err.message : ''
        setStatus(own || "We couldn't save your copy just now — the fit above is yours to keep, and the desk didn't hear about it. Try once more later, or write to us.")
        submit.disabled = false
        submit.textContent = 'Show me my fit'
      })
  })

  function statusLine(body, { email, consent }) {
    const copy = body.copy ? `A copy is on its way to ${email}.` : 'The desk has it.'
    if (!consent) return `${copy} You chose not to join the list — the result is here to keep.`
    if (body.list === 'joined' || body.list === 'held') return `${copy} You're on the createspace list — a few emails a season, and every one carries a link to leave.`
    return `${copy} The list didn't take your address just now; the desk will add you by hand.`
  }
  function setStatus(text) { const s = $('[data-fit-status]'); s.textContent = text; s.hidden = false }

  /* ── the result ───────────────────────────────────────────────────────── */
  function showResult(r, { email, consent }) {
    const top = SERVICE_COPY[r.recommended]
    const second = SERVICE_COPY[r.secondary]
    state.phase = 'result'
    contact.hidden = true
    result.hidden = false
    count.textContent = 'Your fit'
    paintDots()
    $('[data-fit-name]').textContent = top.name
    $('[data-fit-tier]').textContent = top.tier === '03' ? 'Fixed price' : 'Scoped in writing first'
    $('[data-fit-turn]').textContent = top.turnaround
    $('[data-fit-blurb]').textContent = top.blurb
    const why = $('[data-fit-why]')
    why.innerHTML = ''
    r.reasons.forEach((t) => { const li = document.createElement('li'); li.textContent = `because ${t}`; why.appendChild(li) })
    $('[data-fit-fits]').textContent = top.fits
    const cta = $('[data-fit-cta]')
    cta.textContent = top.first
    cta.href = servicePath(r.recommended)
    const sec = $('[data-fit-second]')
    sec.innerHTML = ''
    sec.appendChild(document.createTextNode('The runner-up was the '))
    const a = document.createElement('a'); a.href = servicePath(r.secondary); a.textContent = second.name
    sec.appendChild(a)
    sec.appendChild(document.createTextNode(` — ${second.blurb}`))
    setStatus(consent ? `Saving your copy for ${email}…` : `Saving your copy for ${email}…`)
    result.setAttribute('tabindex', '-1')
    result.focus({ preventScroll: true })
    root.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  $('[data-fit-again]').addEventListener('click', () => {
    state.answers = {}; state.step = 0; state.phase = 'ask'; state.openedAt = Date.now()
    try { sessionStorage.removeItem(STASH) } catch { /* ignore */ }
    result.hidden = true; contact.hidden = true; qEl.hidden = false
    submit.disabled = false; submit.textContent = 'Show me my fit'
    renderQuestion()
    root.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })

  renderQuestion()
}

boot()
