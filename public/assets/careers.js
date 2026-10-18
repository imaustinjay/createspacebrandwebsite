// The careers pages — a posting's live state, and its application drawn from
// careers-core.mjs (the same file the server checks against).
//
//   [data-careers-form="<slug>"]   where the form is drawn. While the posting
//                                  is open: the full application. Before it
//                                  opens (or once it closes, or while paused):
//                                  a short "tell me when it opens" — a name and
//                                  an email, kept on the posting in the
//                                  workspace and written to on the day.
//   [data-posting-state="<slug>"]  a line saying where the posting stands.
//   [data-posting-badge="<slug>"]  a small badge (the careers index).
//
// The window is read live from the workspace (/api/careers-postings, the
// founder's edits in Talent Acquisition); the dates in careers-core.mjs stand
// in when it does not answer within a few seconds. Submissions go to
// /api/careers — never through shop.js, which is why these forms carry
// data-careers-form and not data-form.
import { POSTINGS, FORMS, postingState, dayInWords, readCareers } from './careers-core.mjs?v=4'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid) el.append(kid)
  return el
}

async function livePostings() {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3500)
    const res = await fetch('/api/careers-postings', { signal: ctrl.signal, headers: { accept: 'application/json' } })
    clearTimeout(timer)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    const live = Array.isArray(data.postings) ? data.postings : []
    // The live row wins field by field; a posting the workspace doesn't list keeps its default.
    return POSTINGS.map((p) => ({ ...p, ...(live.find((x) => x.slug === p.slug) || {}) }))
  } catch {
    return POSTINGS.map((p) => ({ ...p }))
  }
}

const stateOf = (p) => (p.state && ['open', 'upcoming', 'closed', 'paused'].includes(p.state) ? p.state : postingState(p))

function stateLine(p) {
  const s = stateOf(p)
  if (s === 'open') return p.closesAt ? `Applications open · the last day is ${dayInWords(p.closesAt)}` : 'Applications open'
  if (s === 'upcoming') return p.opensAt ? `Opens to applications ${dayInWords(p.opensAt)}` : 'Opening soon'
  if (s === 'paused') return 'Applications are paused for now'
  return 'Applications for this round are closed'
}
const BADGE = { open: 'Open', upcoming: 'Opens soon', paused: 'Paused', closed: 'Closed' }

/* ── the form ─────────────────────────────────────────────────────────── */

function control(f) {
  const base = { name: f.id, id: `f-${f.id}`, required: f.required || false, placeholder: f.placeholder || false, autocomplete: f.autocomplete || false }
  if (f.type === 'textarea') return h('textarea', { ...base, maxlength: '4000', rows: '4' })
  if (f.type === 'select') {
    return h('select', base, h('option', { value: '', text: f.required ? 'Choose one' : 'Choose one (optional)' }), f.options.map((o) => h('option', { value: o, text: o })))
  }
  return h('input', { ...base, type: f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : 'text', maxlength: '300' })
}

function field(f) {
  const opt = f.required ? null : h('em', { class: 'opt', text: ' · optional' })
  if (f.type === 'multiselect') {
    return h('fieldset', { class: 'fieldset', 'data-field': f.id },
      h('legend', {}, f.label, h('span', { style: 'font-weight: 500; letter-spacing: 0.04em; text-transform: none;', text: ' Choose any that apply' })),
      h('div', { class: 'choices' }, f.options.map((o) =>
        h('label', { class: 'choice' },
          h('input', { type: 'checkbox', name: f.id, value: o }),
          h('span', { class: 'tick', 'aria-hidden': 'true' }),
          h('span', { class: 'choice-text' }, h('b', { text: o })))),
      ))
  }
  const label = h('label', { class: 'field', 'data-field': f.id, for: `f-${f.id}` }, h('span', {}, f.label, opt), control(f))
  if (f.hint) label.append(h('span', { class: 'field-hint', text: f.hint }))
  return label
}

function answersOf(form) {
  const out = {}
  for (const el of $$('input, textarea, select', form)) {
    if (!el.name || el.name === 'website') continue
    if (el.type === 'checkbox') {
      if (!out[el.name]) out[el.name] = []
      if (el.checked) out[el.name].push(el.value)
    } else out[el.name] = el.value
  }
  return out
}

function buildForm(mount, p) {
  const slug = p.slug
  const open = stateOf(p) === 'open'
  const kind = open ? 'application' : 'interest'
  const form = h('form', { class: 'careers-form', novalidate: true, 'data-kind': kind })
  form.append(h('label', { class: 'hp', 'aria-hidden': 'true' }, 'Leave this field empty ', h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' })))

  if (open) {
    for (const chapter of FORMS[slug]) {
      const box = h('div', { class: 'form-chapter' }, h('h2', { class: 'form-chapter-h', text: chapter.title }))
      if (chapter.intro) box.append(h('p', { class: 'body-14', style: 'margin: -4px 0 4px;', text: chapter.intro }))
      chapter.fields.forEach((f) => box.append(field(f)))
      form.append(box)
    }
  } else {
    const opens = stateOf(p) === 'upcoming' && p.opensAt ? ` on ${dayInWords(p.opensAt)}` : ''
    form.append(
      h('div', { class: 'form-chapter' },
        h('h2', { class: 'form-chapter-h', text: 'Tell me when it opens' }),
        h('p', { class: 'body-14', style: 'margin: -4px 0 4px;', text: `Leave your name and email. The day applications open${opens}, we write to you with the link — once, and only about this role.` }),
        h('div', { class: 'two', style: '--gap: 16px;' },
          field({ id: 'full_name', label: 'Name', type: 'text', required: true, autocomplete: 'name' }),
          field({ id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email' })),
        field({ id: 'note', label: 'Anything you’d like us to know', type: 'textarea' }),
      ),
    )
  }
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true })
  const button = h('button', { class: 'btn btn-primary btn-lg', type: 'submit', text: open ? 'Send my application' : 'Keep me posted' })
  form.append(error, h('div', { style: 'display: flex; flex-wrap: wrap; align-items: center; gap: 14px;' }, button,
    h('span', { class: 'fine-13', style: 'color: var(--muted);', text: open ? 'A person reads every application. You’ll hear from us either way.' : 'One email, on the day. Nothing else.' })))

  const done = h('div', { class: 'done-panel', hidden: true, tabindex: '-1' })
  mount.replaceChildren(form, done)

  const openedAt = Date.now()
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    error.hidden = true
    const answers = answersOf(form)
    const read = readCareers({ posting: slug, kind, answers })
    if (read.error) {
      error.textContent = read.error
      error.hidden = false
      const bad = read.field && (form.querySelector(`[name="${read.field}"]`))
      if (bad) bad.focus()
      return
    }
    button.disabled = true
    button.textContent = 'Sending…'
    try {
      const res = await fetch('/api/careers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posting: slug, kind, answers, website: (form.querySelector('[name="website"]') || {}).value || '', elapsedMs: Date.now() - openedAt }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'send-failed')
      const first = String(read.submission.name).split(/\s+/)[0]
      const filed = data.filed || kind
      done.replaceChildren(
        h('p', { class: 'done-mark', text: filed === 'interest' ? 'On the list' : 'Received' }),
        h('p', { class: 'done-title', text: filed === 'interest' ? `Thank you, ${first}. You’ll hear first.` : `Thank you, ${first}. It’s with us.` }),
        h('p', { class: 'body-15', style: 'margin: 0;', text: filed === 'interest'
          ? `${read.submission.email} gets the link the day applications open.`
          : `A person reads every application by hand. If it resonates, we’ll write to ${read.submission.email} to set up a conversation — and either way, you’ll hear from us.` }),
        data.reference ? h('p', { class: 'fine-13', style: 'margin: 12px 0 0; color: var(--muted);', text: `Reference ${data.reference}` }) : null,
      )
      form.hidden = true
      done.hidden = false
      done.focus({ preventScroll: false })
    } catch (err) {
      error.textContent = err && err.message && err.message !== 'send-failed' ? err.message : "That didn't send — our side, not yours. Give it a moment and try again."
      error.hidden = false
      button.disabled = false
      button.textContent = open ? 'Send my application' : 'Keep me posted'
    }
  })
}

/* ── the page ─────────────────────────────────────────────────────────── */

async function main() {
  const mounts = $$('[data-careers-form]')
  const lines = $$('[data-posting-state]')
  const badges = $$('[data-posting-badge]')
  if (!mounts.length && !lines.length && !badges.length) return
  const postings = await livePostings()
  const find = (slug) => postings.find((p) => p.slug === slug)
  for (const el of lines) { const p = find(el.getAttribute('data-posting-state')); if (p) el.textContent = stateLine(p) }
  for (const el of badges) {
    const p = find(el.getAttribute('data-posting-badge'))
    if (!p) continue
    const s = stateOf(p)
    el.textContent = BADGE[s]
    el.setAttribute('data-state', s)
  }
  for (const mount of mounts) { const p = find(mount.getAttribute('data-careers-form')); if (p && FORMS[p.slug]) buildForm(mount, p) }
}

main()
