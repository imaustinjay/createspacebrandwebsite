// New client service inquiry — the intake behind /inquire/ (and the tap card's
// "start an inquiry" button). Sends the inquiry to the desk mailbox and a
// short acknowledgement copy to the person who sent it.
//
// Conventions (honeypot, minimum fill time, per-IP limit) are identical to
// enquiry.mjs and shop.mjs; the mail itself goes through the house mailer in
// netlify/shared/mail.mjs. Destination: INQUIRY_EMAIL, falling back to the
// mailer's own default (SHOP_EMAIL / PARTNERSHIPS_EMAIL / hello@) — server-side
// only, never echoed to the client.
import { sendMail, mailbox, esc } from '../shared/mail.mjs'
import { clean } from '../shared/catalog.mjs'

const SERVICES = {
  partnership: 'Brand partnership (hire creators from the roster)',
  ugc: 'UGC + content production',
  strategy: 'Social strategy + brand direction',
  representation: 'Creator representation',
  events: 'Events + community',
  other: 'Something else',
}
const PLATFORMS = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  owned: 'Their own channels',
  irl: 'In person',
}
const TIMINGS = {
  now: 'As soon as possible',
  '1-3mo': 'In the next 1–3 months',
  '3-6mo': 'In 3–6 months',
  exploring: 'Just exploring for now',
}
const BUDGETS = {
  'under-5k': 'Under $5,000',
  '5-15k': '$5,000 – $15,000',
  '15-50k': '$15,000 – $50,000',
  '50k-plus': '$50,000+',
  unsure: 'Not sure yet',
  na: 'Not applicable',
}
const CONTACTS = { email: 'Email', call: 'A phone call', text: 'A text' }
const SOURCES = {
  'in-person': 'We met in person',
  creator: 'Through a creator',
  referral: 'A referral',
  search: 'Search',
  social: 'Social',
  other: 'Somewhere else',
}

const str = (v, max) => String(v ?? '').trim().slice(0, max)
const pick = (v, map) => (Array.isArray(v) ? v : [v]).map(String).filter((k) => map[k])

// Rate limiting: durable per-IP counter in Netlify Blobs when available, with
// an in-memory fallback (per warm instance) so local dev still has a guard.
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('inquiry-rate')
    const hits = ((await store.get(ip, { type: 'json' })) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    await store.setJSON(ip, hits)
    return false
  } catch {
    const hits = (memoryHits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
    if (hits.length >= MAX_PER_WINDOW) return true
    hits.push(now)
    memoryHits.set(ip, hits)
    return false
  }
}

// Pure: validate + shape the submission. Returns { error } or { inquiry }.
export function readInquiry(body = {}) {
  const inquiry = {
    name: str(body.name, 120),
    email: str(body.email, 200),
    company: str(body.company, 160),
    role: str(body.role, 120),
    phone: str(body.phone, 40),
    handle: str(body.handle, 200),
    services: pick(body.services, SERVICES),
    project: str(body.project, 3000),
    platforms: pick(body.platforms, PLATFORMS),
    timing: TIMINGS[body.timing] ? String(body.timing) : '',
    budget: BUDGETS[body.budget] ? String(body.budget) : '',
    contact: CONTACTS[body.contact] ? String(body.contact) : 'email',
    source: SOURCES[body.source] ? String(body.source) : '',
    notes: str(body.notes, 500),
    via: body.via === 'card' ? 'card' : '',
  }

  if (!inquiry.name || !inquiry.email || !inquiry.services.length || !inquiry.project) {
    return { error: "Please fill in your name, email, at least one thing you're interested in, and what you're trying to make." }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) {
    return { error: "That email doesn't look complete — mind checking it?" }
  }
  if ((inquiry.contact === 'call' || inquiry.contact === 'text') && !inquiry.phone) {
    return { error: 'You asked for a call or a text — add a phone number so we can reach you that way.' }
  }
  return { inquiry }
}

const rowsHtml = (rows) =>
  rows
    .map(
      ([k, v]) => `<tr>
          <td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); white-space: nowrap; vertical-align: top;">${esc(k)}</td>
          <td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10);">${esc(v)}</td>
        </tr>`
    )
    .join('')

// The desk copy — every field, labelled, in the house palette.
export function renderDeskMail(q) {
  const rows = [
    ['Name', q.name],
    ['Email', q.email],
    ['Company / brand / project', q.company || '—'],
    ['Role', q.role || '—'],
    ['Phone', q.phone || '—'],
    ['Website / handle', q.handle || '—'],
    ['Interested in', q.services.map((k) => SERVICES[k]).join('; ')],
    ['Where it should live', q.platforms.length ? q.platforms.map((k) => PLATFORMS[k]).join(', ') : '—'],
    ['Timing', TIMINGS[q.timing] || '—'],
    ['Budget range', BUDGETS[q.budget] || '—'],
    ['Reply by', CONTACTS[q.contact]],
    ['How they found us', SOURCES[q.source] || '—'],
    ['Arrived via', q.via === 'card' ? 'The tap card' : 'createspacebrand.com/inquire'],
    ['Anything else', q.notes || '—'],
  ]
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nWhat they're trying to make:\n${q.project}\n`
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">New client inquiry &middot; createspacebrand.com${q.via === 'card' ? ' &middot; from the tap card' : ''}</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 600px;">${rowsHtml(rows)}</table>
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 22px 0 8px;">What they're trying to make</p>
      <div style="background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; padding: 16px; max-width: 600px; font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${esc(q.project)}</div>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 16px 0 0;">Reply goes straight to them — reply-to is set to their address.</p>
    </div>`
  return { text, html }
}

// The acknowledgement copy to the person — short, in the house voice, with
// what they sent underneath so they have it too.
export function renderAckMail(q) {
  const firstName = q.name.split(/\s+/)[0]
  const summary = [
    ['Interested in', q.services.map((k) => SERVICES[k]).join('; ')],
    ['Timing', TIMINGS[q.timing] || 'Not set'],
    ['Budget range', BUDGETS[q.budget] || 'Not set'],
    ['Reply by', CONTACTS[q.contact]],
  ]
  const text = `Hi ${firstName},

It's in. Thank you for trusting us with it.

A person will read the whole thing and come back to you within two working days — with next steps, a shortlist, or an honest not-a-fit. No automated decisions here.

What you sent:
${summary.map(([k, v]) => `${k}: ${v}`).join('\n')}

What you're trying to make:
${q.project}

— createspace · community + talent
https://createspacebrand.com
`
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 18px;">createspace &middot; community + talent</p>
      <p style="font-size: 20px; font-weight: 300; margin: 0 0 14px;">Hi ${esc(firstName)} — it's in. Thank you for trusting us with it.</p>
      <p style="font-size: 14px; line-height: 1.7; margin: 0 0 22px; max-width: 56ch;">A person will read the whole thing and come back to you within two working days — with next steps, a shortlist, or an honest not-a-fit. No automated decisions here.</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px;">${rowsHtml(summary)}</table>
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 22px 0 8px;">What you're trying to make</p>
      <div style="background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; padding: 16px; max-width: 560px; font-size: 14px; line-height: 1.7; white-space: pre-wrap;">${esc(q.project)}</div>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 20px 0 0;">Replying to this email reaches us directly.</p>
    </div>`
  return { text, html }
}

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  // Bot signals: a filled honeypot or a sub-3-second fill. Pretend success so
  // the automation moves on with nothing learned; nothing is sent.
  const elapsedMs = Number(body.elapsedMs || 0)
  if (String(body.website || '') || (elapsedMs > 0 && elapsedMs < 3000)) {
    console.log('inquiry: discarded as bot signals', { elapsedMs })
    return Response.json({ ok: true })
  }

  const { error, inquiry } = readInquiry(body)
  if (error) return Response.json({ error }, { status: 400 })

  const ip =
    context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json(
      { error: "That's a few inquiries in quick succession — give it a little while and try again." },
      { status: 429 }
    )
  }

  const box = mailbox()
  if (!box) {
    return Response.json(
      { error: "The front desk isn't connected yet. Give us a day and try again — we'd genuinely like to hear from you." },
      { status: 503 }
    )
  }
  const to = clean(process.env.INQUIRY_EMAIL) || box.to

  const desk = renderDeskMail(inquiry)
  const sent = await sendMail({
    to,
    replyTo: { name: inquiry.name, address: inquiry.email },
    subject: `New client inquiry — ${inquiry.company || inquiry.name}${inquiry.via === 'card' ? ' (tap card)' : ''}`,
    text: desk.text,
    html: desk.html,
  })
  if (!sent.ok) {
    // Never leak SMTP detail (or the destination) to the public form.
    return Response.json(
      { error: "That didn't send — our side, not yours. Give it a moment and try again." },
      { status: 502 }
    )
  }

  // The acknowledgement is best-effort: the desk has the inquiry either way.
  const ack = renderAckMail(inquiry)
  await sendMail({
    to: { name: inquiry.name, address: inquiry.email },
    replyTo: { name: box.fromName, address: to },
    subject: 'Received — createspace · community + talent',
    text: ack.text,
    html: ack.html,
  })

  return Response.json({ ok: true })
}
