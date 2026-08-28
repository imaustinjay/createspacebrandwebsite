// /api/billing — the billing desk. The agency's invoices, issued and read
// from inside the site's own portal.
//
//   GET                          → the ledger: recent hand-raised invoices
//   POST { action: 'issue' }     → create one, finalize it, email it — ours
//   POST { action: 'resend' }    → send the branded email again
//   POST { action: 'void' }      → cancel an open invoice, permanently
//
// Stripe holds the invoice, takes the payment on its hosted page, and pays
// the balance out with everything else the site earns. What Stripe does NOT
// do here is talk to the brand: its own invoice email stays off, and the
// house sends its own — same palette and voice as the shop's receipt — with
// Stripe's hosted page behind the one button. The card is typed on Stripe's
// page, so no card field exists here, exactly as everywhere else on this
// site.
//
// A brand needs no website account to be invoiced: a name and an email are
// enough. If that address ever creates an account, the invoice is already
// waiting in their portal — /api/account matches invoices by proven address.
//
// Behind the portal session (the passphrase + mailed-code login), not the
// stockroom token: issuing an invoice is signing the house's name to a
// number, which is an owner's act, not an uploader's.
import { money, stripeClient } from '../shared/catalog.mjs'
import { readSession } from '../shared/admin-session.mjs'
import { brandInvoiceEmail } from '../shared/invoice-mail.mjs'
import { sendMail } from '../shared/mail.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MAX_LINES = 20
const MAX_LINE_CENTS = 5_000_000 // $50,000 a line; past that, talk to a human
const MIN_TOTAL_CENTS = 100 // Stripe's own floor is 50¢; a dollar keeps it clean

// What the brand can pay with. The shop's one-off checkout leaves this to the
// dashboard (`automatic_payment_methods`), which is right for a $47 preset
// pack — but the services page makes a specific promise about four-figure
// work: "payment plans are available on services and programs through
// third-party processors including Klarna and Afterpay". A promise a page
// makes has to be true on the invoice, so the desk asks for them by name
// rather than hoping the dashboard default happens to include them.
//
// Override with STRIPE_INVOICE_PAYMENT_METHODS (comma-separated) to add or
// drop one without a deploy. Stripe refuses a method the account has not
// activated, and refuses the plan methods outright above their own ceilings
// (Afterpay's is a few thousand dollars) — so a refusal falls back to the
// account default and still issues the invoice. An unpayable invoice would be
// a worse outcome than a card-only one.
const DEFAULT_INVOICE_METHODS = ['card', 'klarna', 'afterpay_clearpay']

function invoiceMethods() {
  const raw = String(process.env.STRIPE_INVOICE_PAYMENT_METHODS || '').trim()
  if (!raw) return DEFAULT_INVOICE_METHODS
  const picked = raw.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
  return picked.length ? picked : DEFAULT_INVOICE_METHODS
}

// Stripe says no to an un-activated or out-of-range payment method in a few
// different shapes. Match narrowly: a genuine failure (a dead key, a deleted
// customer) must still surface as one rather than be retried into silence.
function isMethodRefusal(err) {
  const text = String(err?.message || '').toLowerCase()
  const code = String(err?.code || '')
  if (code === 'payment_method_not_available' || code === 'invoice_payment_method_not_available') return true
  if (!text) return false
  return (
    text.includes('payment_method_types') ||
    text.includes('payment method type') ||
    text.includes('klarna') ||
    text.includes('afterpay')
  )
}

const say = (body, status = 200) => Response.json(body, { status, headers: NO_STORE })

export default async (req, context) => {
  if (!readSession(req)) {
    return say({ ok: false, reason: 'signed-out' }, 401)
  }

  const stripe = stripeClient()
  if (!stripe) return say({ ok: false, reason: 'not-configured', error: 'STRIPE_SECRET_KEY is not set.' }, 503)

  if (req.method === 'GET') return ledger(stripe)
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body
  try {
    body = await req.json()
  } catch {
    return say({ ok: false, error: 'That did not read as a request.' }, 400)
  }

  const action = String(body?.action || '')
  if (action === 'issue') return issue(stripe, body, req)
  if (action === 'resend') return resend(stripe, body, req)
  if (action === 'void') return voidOne(stripe, body)
  return say({ ok: false, error: 'Unknown action.' }, 400)
}

// --------------------------------------------------------------- the ledger
//
// Hand-raised invoices only. The craft's subscription cycles are invoices
// too, and they belong under a member's account, not next to a brand's
// $4,500 engagement — so anything born of a subscription stays out.
async function ledger(stripe) {
  let rows
  try {
    ;({ data: rows } = await stripe.invoices.list({ limit: 40 }))
  } catch (err) {
    console.error('billing: ledger read failed —', err?.message || err)
    return say({ ok: false, reason: 'unreachable', error: 'Stripe did not answer.' }, 502)
  }

  const invoices = rows
    .filter((inv) => !inv.subscription)
    .map(present)

  const open = invoices.filter((i) => i.status === 'open')
  return say({
    ok: true,
    invoices,
    outstanding: money(open.reduce((sum, i) => sum + i.amountDueCents, 0), 'usd'),
    openCount: open.length,
  })
}

function present(inv) {
  return {
    id: inv.id,
    number: inv.number || inv.id,
    status: inv.status, // draft · open · paid · void · uncollectible
    total: money(inv.total, inv.currency),
    amountDueCents: inv.status === 'open' ? inv.amount_due : 0,
    name: inv.customer_name || '',
    email: inv.customer_email || '',
    memo: inv.description || '',
    issuedAt: iso(inv.created),
    dueAt: iso(inv.due_date),
    paidAt: iso(inv.status_transitions?.paid_at),
    href: inv.hosted_invoice_url || null,
    pdf: inv.invoice_pdf || null,
  }
}

const iso = (unix) => (typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null)

// ----------------------------------------------------------------- issuing
async function issue(stripe, body, req) {
  const name = String(body?.name || '').trim().slice(0, 120)
  const company = String(body?.company || '').trim().slice(0, 160)
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 200)
  const memo = String(body?.memo || '').trim().slice(0, 500)
  const days = Math.min(90, Math.max(1, Math.round(Number(body?.daysUntilDue) || 14)))

  if (!name) return say({ ok: false, error: 'Add the contact name.' }, 400)
  if (!EMAIL_RE.test(email)) return say({ ok: false, error: 'That email does not look right.' }, 400)

  // Lines arrive as { description, amount } with the amount in dollars, the
  // way a person types it. Cents happen here, once, carefully.
  const raw = Array.isArray(body?.lines) ? body.lines.slice(0, MAX_LINES) : []
  const lines = []
  for (const line of raw) {
    const description = String(line?.description || '').trim().slice(0, 250)
    const cents = Math.round(Number(String(line?.amount ?? '').replace(/[$,\s]/g, '')) * 100)
    if (!description) continue
    if (!isFinite(cents) || cents <= 0) return say({ ok: false, error: `"${description}" has no readable amount.` }, 400)
    if (cents > MAX_LINE_CENTS) return say({ ok: false, error: `"${description}" is past the $50,000 line ceiling.` }, 400)
    lines.push({ description, cents })
  }
  if (!lines.length) return say({ ok: false, error: 'An invoice needs at least one line.' }, 400)
  const totalCents = lines.reduce((sum, l) => sum + l.cents, 0)
  if (totalCents < MIN_TOTAL_CENTS) return say({ ok: false, error: 'The total has to be at least $1.' }, 400)

  try {
    // One customer per address — reuse before create, so a brand invoiced
    // twice is one row in Stripe, and one Brand billing pane on the site.
    const { data: found } = await stripe.customers.list({ email, limit: 1 })
    const customer =
      found[0] ||
      (await stripe.customers.create({
        email,
        name: company || name,
        metadata: { contact: name, ...(company ? { company } : {}), via: 'billing-desk' },
      }))

    // The invoice first, then its items pinned to it by id — never
    // "whatever items happen to be pending", which would sweep in strays.
    const base = {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: days,
      description: memo || undefined,
      pending_invoice_items_behavior: 'exclude',
      auto_advance: false,
    }
    let planMethods = invoiceMethods()
    let invoice
    try {
      invoice = await stripe.invoices.create({
        ...base,
        payment_settings: { payment_method_types: planMethods },
      })
    } catch (err) {
      if (!isMethodRefusal(err)) throw err
      console.warn('billing: Stripe would not take', planMethods.join(', '), '— issuing on the account default instead:', err?.message || err)
      planMethods = null
      invoice = await stripe.invoices.create(base)
    }

    for (const line of lines) {
      await stripe.invoiceItems.create({
        customer: customer.id,
        invoice: invoice.id,
        description: line.description,
        amount: line.cents,
        currency: 'usd',
      })
    }

    // The total is only known once the items are on, and the plan methods
    // have their own ceilings — so a refusal can arrive here rather than at
    // create. Drop back to the account default and finalize, instead of
    // leaving a draft nobody can pay.
    let final
    try {
      final = await stripe.invoices.finalizeInvoice(invoice.id)
    } catch (err) {
      if (!planMethods || !isMethodRefusal(err)) throw err
      console.warn('billing: plan methods refused at finalize — retrying on the account default:', err?.message || err)
      await stripe.invoices.update(invoice.id, { payment_settings: { payment_method_types: '' } })
      planMethods = null
      final = await stripe.invoices.finalizeInvoice(invoice.id)
    }

    // The house's own email. Stripe's stays off; if ours cannot send, the
    // invoice still exists and the answer says so with the link in hand,
    // rather than failing the whole issue over the last step.
    const mailed = await sendBranded(final, { name, company, memo }, req)

    const offered = final.payment_settings?.payment_method_types || null
    console.log('billing: invoice issued', { number: final.number, total: final.total, methods: offered || 'account default' })
    return say({
      ok: true,
      invoice: present(final),
      mailed: mailed.ok,
      mailReason: mailed.ok ? null : mailed.reason,
      // The desk says what the brand will actually be offered, rather than
      // what was asked for — the two differ when Stripe refuses one.
      plans: !!(offered && offered.some((m) => m === 'klarna' || m === 'afterpay_clearpay')),
    })
  } catch (err) {
    console.error('billing: issue failed —', err?.message || err)
    return say({ ok: false, error: 'Stripe refused that: ' + (err?.message || 'no reason given.') }, 502)
  }
}

async function resend(stripe, body, req) {
  const id = String(body?.id || '')
  if (!/^in_[A-Za-z0-9]+$/.test(id)) return say({ ok: false, error: 'That is not an invoice id.' }, 400)
  try {
    const invoice = await stripe.invoices.retrieve(id)
    if (invoice.status !== 'open') return say({ ok: false, error: 'Only an open invoice can be re-sent.' }, 400)
    const mailed = await sendBranded(invoice, { name: invoice.customer_name || '', company: '', memo: invoice.description || '' }, req)
    if (!mailed.ok) return say({ ok: false, error: 'The mailbox is not connected — nothing was sent.' }, 503)
    return say({ ok: true })
  } catch (err) {
    console.error('billing: resend failed —', err?.message || err)
    return say({ ok: false, error: 'Stripe refused that: ' + (err?.message || 'no reason given.') }, 502)
  }
}

async function voidOne(stripe, body) {
  const id = String(body?.id || '')
  if (!/^in_[A-Za-z0-9]+$/.test(id)) return say({ ok: false, error: 'That is not an invoice id.' }, 400)
  try {
    const gone = await stripe.invoices.voidInvoice(id)
    console.log('billing: invoice voided', { number: gone.number })
    return say({ ok: true, invoice: present(gone) })
  } catch (err) {
    console.error('billing: void failed —', err?.message || err)
    return say({ ok: false, error: 'Stripe refused that: ' + (err?.message || 'no reason given.') }, 502)
  }
}

async function sendBranded(invoice, { name, company, memo }, req) {
  if (!invoice.hosted_invoice_url || !invoice.customer_email) {
    return { ok: false, reason: 'no-link' }
  }
  const { subject, text, html } = brandInvoiceEmail({
    number: invoice.number || invoice.id,
    contact: name,
    company,
    memo,
    lines: (invoice.lines?.data || []).map((l) => ({
      description: l.description || '',
      display: money(l.amount, invoice.currency),
    })),
    total: money(invoice.total, invoice.currency),
    dueAt: iso(invoice.due_date),
    payUrl: invoice.hosted_invoice_url,
    pdfUrl: invoice.invoice_pdf || null,
  })
  return sendMail({ to: invoice.customer_email, subject, text, html })
}
