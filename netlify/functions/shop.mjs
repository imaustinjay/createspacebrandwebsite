// The shop desk — every form the storefront added lands here.
//
// The design drew these forms with client-side confirmations, which is right
// for a prototype and wrong for a live site: a page that says "it's in our
// inbox" has to actually put it there. So each form posts here and the
// confirmation is only shown once this returns ok. If the mailbox isn't
// configured the visitor gets a calm, honest "not connected yet" instead of a
// false success — the same contract as the brand enquiry desk.
//
// Conventions (honeypot, minimum fill time, per-IP limit, SMTP env names) are
// deliberately identical to netlify/functions/enquiry.mjs.
import nodemailer from 'nodemailer'

// What each form is allowed to send, in the order it reads in the email.
// Anything not named here is dropped — a form can never widen its own payload.
const FORMS = {
  contact: {
    subject: (f) => `Shop contact — ${f.topic || 'Something else'}`,
    fields: [
      ['name', 'Name'],
      ['email', 'Email', 'required'],
      ['topic', "What it's about"],
      ['message', 'Message', 'required'],
    ],
  },
  // The Collection Program's notify list, as a fallback. /collection/ posts to
  // /api/cohort-status first — the workspace holds the real list — and only
  // lands here when that endpoint can't be reached, so a reader who asked to be
  // told is never lost to a deployment gap. An email is the whole point of it;
  // the rest of the fields stay accepted for anything still posting them.
  cohort: {
    subject: () => 'The Collection Program — notify list',
    fields: [
      ['name', 'Name'],
      ['email', 'Email', 'required'],
      ['handle', 'Handle'],
      ['stage', 'Where they’re at'],
      ['goal', 'What would make it worth it'],
    ],
  },
  internship: {
    subject: (f) => `Internship application — ${f.name || 'unnamed'}`,
    fields: [
      ['name', 'Name', 'required'],
      ['email', 'Email', 'required'],
      ['area', 'Area'],
      ['link', 'Link to their work', 'required'],
    ],
  },
  careers: {
    subject: () => 'Careers alert — new signup',
    fields: [['email', 'Email', 'required']],
  },
  workshop: {
    subject: () => 'Workshop notify list — new signup',
    fields: [['email', 'Email', 'required']],
  },
  waitlist: {
    subject: () => 'Fall Drop first-look list — new signup',
    fields: [['email', 'Email', 'required']],
  },
  account: {
    // Accounts open with the launch, so this is a reservation, not a signup.
    // The password never leaves the browser — shop.js strips it before send,
    // and there is no field for it here either way.
    subject: () => 'Account at launch — reservation',
    fields: [
      ['name', 'Name'],
      ['email', 'Email', 'required'],
      ['agree', 'Accepted terms & happy to hear from us'],
    ],
  },
}

const LIMITS = { message: 4000, goal: 2000, default: 300 }

// Env values arrive however they were pasted — strip wrapping quotes and edge
// whitespace, never interior content (same reasoning as enquiry.mjs).
function clean(v) {
  if (typeof v !== 'string') return v
  let s = v.trim()
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 8
const memoryHits = new Map()

async function overLimit(ip) {
  const now = Date.now()
  try {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore('shop-rate')
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

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  const form = FORMS[String(body.kind || '')]
  if (!form) return Response.json({ error: 'Bad request' }, { status: 400 })

  // Bot signals: a filled honeypot or a sub-3-second fill. Pretend success so
  // the automation moves on with nothing learned; nothing is sent.
  const elapsedMs = Number(body.elapsedMs || 0)
  if (String(body.website || '') || (elapsedMs > 0 && elapsedMs < 3000)) {
    // Logged so a too-quick human test is distinguishable from a real send in
    // the function log; the visitor still sees success either way.
    console.log('shop desk: discarded as bot signals', { kind: body.kind, elapsedMs })
    return Response.json({ ok: true })
  }

  const values = {}
  for (const [key, , required] of form.fields) {
    const raw = body[key]
    const value = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw ?? '').trim()
    values[key] = value.slice(0, LIMITS[key] || LIMITS.default)
    if (required && !values[key]) {
      return Response.json({ error: 'Something’s missing — check the form and try again.' }, { status: 400 })
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email || '')) {
    return Response.json({ error: "That email doesn't look complete — mind checking it?" }, { status: 400 })
  }

  const ip =
    context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown'
  if (await overLimit(ip)) {
    return Response.json(
      { error: "That's a few in quick succession — give it a little while and try again." },
      { status: 429 }
    )
  }

  // Destination: the house inbox, hello@createspacebrand.com, for now — an
  // env var still overrides it without a code change if role mailboxes return.
  const to =
    clean(process.env.SHOP_EMAIL || process.env.PARTNERSHIPS_EMAIL) || 'hello@createspacebrand.com'
  const user = clean(process.env.MAIL_USER || process.env.TITAN_EMAIL)
  const password = clean(process.env.MAIL_PASSWORD || process.env.TITAN_PASSWORD)
  if (!to || !user || !password) {
    return Response.json(
      { error: "The desk isn't connected yet. Give us a day and try again — we'd genuinely like to hear from you." },
      { status: 503 }
    )
  }

  const transporter = nodemailer.createTransport({
    host: clean(process.env.MAIL_SMTP_HOST || process.env.TITAN_SMTP_HOST) || 'smtp.titan.email',
    port: Number(clean(process.env.MAIL_SMTP_PORT || process.env.TITAN_SMTP_PORT)) || 465,
    secure: true,
    auth: { user, pass: password },
  })

  const rows = form.fields.map(([key, label]) => [label, values[key] || '—'])
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  const html = `
    <div style="font-family: Arial, sans-serif; color: #4E312C; background: #FFFFF0; padding: 28px;">
      <p style="font-size: 11px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; color: #567363; margin: 0 0 14px;">${esc(
        form.subject(values)
      )} &middot; createspacebrand.com</p>
      <table style="border-collapse: collapse; background: #FFFFFF; border: 1px solid rgba(78,49,44,0.14); border-radius: 12px; width: 100%; max-width: 560px;">
        ${rows
          .map(
            ([k, v]) => `<tr>
          <td style="padding: 10px 16px; font-size: 12px; color: rgba(78,49,44,0.55); border-bottom: 1px solid rgba(78,49,44,0.10); white-space: nowrap; vertical-align: top;">${esc(k)}</td>
          <td style="padding: 10px 16px; font-size: 14px; border-bottom: 1px solid rgba(78,49,44,0.10); white-space: pre-wrap;">${esc(v)}</td>
        </tr>`
          )
          .join('')}
      </table>
      <p style="font-size: 12px; color: rgba(78,49,44,0.55); margin: 16px 0 0;">Reply goes straight to them — reply-to is set to their address.</p>
    </div>`

  try {
    await transporter.sendMail({
      from: { name: clean(process.env.MAIL_FROM_NAME) || 'createspace · community + talent', address: user },
      to,
      replyTo: values.name ? { name: values.name, address: values.email } : values.email,
      subject: form.subject(values),
      text,
      html,
    })
    console.log('shop desk: sent', { kind: body.kind, to })
    return Response.json({ ok: true })
  } catch (err) {
    // Never leak SMTP detail (or the destination) to the public form — but do
    // put the provider's actual answer in the private function log.
    console.error('shop desk: SMTP send failed —', err?.message || err)
    return Response.json(
      { error: "That didn't send — our side, not yours. Give it a moment and try again." },
      { status: 502 }
    )
  }
}
