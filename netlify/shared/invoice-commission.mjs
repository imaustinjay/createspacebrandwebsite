// A paid invoice, as a commission — the decision, the sending, and the two
// notices that keep a paid invoice from ever going quiet.
//
// The agency's other way of being paid. A client who is invoiced rather than
// sent to a checkout reaches the desk through `invoice.paid`, and only through
// it: there is no order record, no receipt and no download token behind an
// invoice. Which is exactly why this module exists as its own thing, reachable
// from two doors —
//
//   · the webhook, the instant Stripe says the money landed; and
//   · the billing desk, afterwards, by hand — for the invoice that was paid
//     and opened nothing. Raised without a service picked, raised in the
//     Stripe dashboard with no metadata, paid while the bridge was down: each
//     is one paid invoice and one waiting client, and the fix is the same
//     action, so it lives here once.
//
// Everything in `invoiceCommission` is a guard, and each one exists because
// without it something specific goes wrong:
//
//   · The craft membership renews by subscription, and a subscription cycle IS
//     an invoice. Without the first guard every $29 renewal would open a
//     done-for-you engagement.
//   · A trialling membership's first invoice is $0 and Stripe marks it paid by
//     itself. Without the second, a free trial would open one too.
//   · Invoices raised by hand carry whatever metadata a person typed, usually
//     none. They pass through — but no longer in silence: a paid invoice with
//     no service on it is the one thing here that used to vanish, and it now
//     writes to the desk instead (see `untaggedPaidNotice`).
//
// There is deliberately NO order record. `ensureOrder` writes under
// `by-intent/`, which the stockroom ledger and the account scan both read
// blind and unfiltered — an invoice has no download entitlement, no receipt
// and no token, so a row there would be pollution. Idempotency instead rests
// on the reference, which is minted when the invoice is TAGGED and lives in
// its metadata: every Stripe retry carries the same one, the billing desk's
// "send it again" carries the same one, and the workspace holds `reference`
// as a primary key and answers a repeat with the engagement it already opened.
import { money, subscriptionInvoice } from './catalog.mjs'
import { SERVICES, isServiceReference, serviceReference } from './services.mjs'
import { commissionFromOrder, deliverCommission, flushOutbox } from './commission.mjs'

/**
 * The decision, pure: does this invoice open an engagement, and as what?
 *
 * Returns `{ reason }` for every invoice that should pass through untouched,
 * or `{ commission, reference, service }` for one that should cross to the
 * workspace. Separated from the sending so the guards — which are the entire
 * value of this branch — are a thing that can be tested without a network, a
 * Stripe, or a workspace.
 */
export function invoiceCommission(inv = {}) {
  const meta = inv.metadata || {}

  if (subscriptionInvoice(inv)) return { reason: 'subscription' }

  // `amount_paid` and not `total`: a fully discounted invoice is still nothing
  // collected, and an engagement is not opened on nothing collected.
  if (!(Number(inv.amount_paid) > 0)) return { reason: 'nothing-paid' }

  if (meta.kind !== 'service') return { reason: 'not-a-service' }

  const service = SERVICES[meta.service]
  if (!service) return { reason: 'unknown-service' }

  // The dedupe key. Without it a Stripe retry — and Stripe retries for days —
  // opens a second engagement for one payment, so a missing one is refused
  // loudly rather than papered over with a fresh reference.
  const reference = String(meta.reference || '').trim()
  if (!reference) return { reason: 'no-reference' }

  // `customers.create` in the billing desk sets `name: company || contact`, so
  // `customer_name` here may be the company. The person's name is carried in
  // the invoice's own metadata for exactly this reason.
  const name = String(meta.contact || inv.customer_name || '').trim()
  const email = String(meta.email || inv.customer_email || '').trim().toLowerCase()
  // The workspace rejects both outright, and a rejected commission sits in the
  // outbox being retried forever without ever being able to succeed.
  if (!name || !email) return { reason: 'incomplete' }

  const mode = meta.mode === 'deposit' ? 'deposit' : 'full'
  return {
    service: meta.service,
    reference,
    commission: commissionFromOrder({
      order: {
        reference,
        name,
        email,
        handle: '',
        platform: '',
        niche: '',
        joinCraft: false,
        currency: inv.currency || 'usd',
        amount: Number(inv.amount_paid) || 0,
        // Absent on a deposit invoice on purpose — the billing desk takes
        // free-text lines and does not know the whole fee, so the workspace
        // applies the house convention rather than a number we invented.
        fullAmount: Number(meta.fullAmount) > 0 ? Number(meta.fullAmount) : 0,
      },
      service,
      mode,
      // The invoice's own id, so the engagement's origin points at the thing
      // that was actually paid and a person can find it in Stripe.
      intent: { id: inv.id },
      answers: {},
      notes: [inv.number && `Invoice ${inv.number}`, inv.description].filter(Boolean).join('\n'),
    }),
  }
}

/**
 * What the invoice is tagged with, for the ledger: `{ id, name, mode,
 * reference }`, or null for an ordinary invoice. A tag naming a service we do
 * not sell is still shown — as what it says, so the typo is visible — but
 * `known` is false and the desk offers to re-tag it.
 */
export function serviceTag(inv = {}) {
  const meta = inv.metadata || {}
  if (meta.kind !== 'service') return null
  const id = String(meta.service || '').trim()
  return {
    id,
    name: SERVICES[id]?.name || id || 'a service',
    known: Boolean(SERVICES[id]),
    mode: meta.mode === 'deposit' ? 'deposit' : 'full',
    reference: String(meta.reference || '').trim(),
  }
}

/**
 * The metadata that turns an already-paid, untagged invoice into a service
 * invoice — pure, so what gets written to Stripe can be read in a test.
 *
 * Returns `{ metadata }` or `{ error }`. The same rules as issuing: the
 * service has to be one we sell, and a pasted reference has to be one of ours
 * (it continues an engagement that is already open) or blank (a new one is
 * minted). The contact's name comes from the invoice's own customer unless the
 * desk types a better one — a dashboard-raised invoice often has the company
 * where the person should be.
 */
export function retagMetadata(inv = {}, { service, mode, reference, contact, bytes, year } = {}) {
  const serviceId = String(service || '').trim().slice(0, 64)
  if (!serviceId) return { error: 'Pick the service this invoice paid for.' }
  if (!SERVICES[serviceId]) return { error: 'That is not a service we offer.' }

  const given = String(reference || '').trim().toUpperCase()
  if (given && !isServiceReference(given)) {
    return { error: 'That reference is not one of ours — it should look like CS-SVC-2026-K7M2PQ.' }
  }

  const name = String(contact || inv.customer_name || '').trim().slice(0, 200)
  const email = String(inv.customer_email || '').trim().toLowerCase().slice(0, 200)
  if (!name) return { error: 'Stripe holds no name for this customer — add the contact name.' }
  if (!email) return { error: 'Stripe holds no email for this customer, and the engagement is addressed to one. Add it to the customer in Stripe first.' }

  const paymentMode = mode === 'deposit' ? 'deposit' : 'full'
  const ref = given || serviceReference(bytes, year)

  return {
    metadata: {
      // Whatever was already there survives — Stripe's own `update` replaces
      // keys it is given and keeps the rest, but a desk that read it back
      // should see the same thing either way.
      ...(inv.metadata || {}),
      kind: 'service',
      service: serviceId,
      mode: paymentMode,
      reference: ref,
      contact: name,
      email,
      // A 'full' invoice's total IS the engagement's value. On a deposit the
      // whole fee is unknown here, so it is left unsaid and the workspace
      // applies the house convention rather than a number we invented.
      ...(paymentMode === 'full' && Number(inv.amount_paid) > 0 ? { fullAmount: String(inv.amount_paid) } : {}),
      source: 'billing-desk',
      // The honest record: this tag was added AFTER the money landed, by a
      // person, not at issue. Useful the day somebody asks why the engagement
      // opened later than the payment.
      taggedAfterPaid: new Date().toISOString().slice(0, 10),
    },
    reference: ref,
    service: serviceId,
    mode: paymentMode,
  }
}

/**
 * The sending, thin, around the decision above. Shared by the webhook and by
 * the billing desk's "open the engagement" button, so the two doors cannot
 * drift.
 *
 * Returns `{ ok: true, engagement, duplicate, reference, service }`, or
 * `{ ok: false, reason }` when the invoice should not open anything, or
 * `{ ok: false, held: true, retry, error, reference, service }` when it should
 * have and the bridge would not take it (the commission is in the outbox).
 */
export async function commissionPaidInvoice(inv) {
  const { reason, commission, reference, service } = invoiceCommission(inv)
  if (reason) return { ok: false, reason }

  const sent = await deliverCommission(commission)
  if (sent.ok) {
    // A working bridge is the best moment to clear anything held while it
    // was not working.
    flushOutbox({ limit: 5 }).catch(() => {})
    return { ok: true, engagement: sent.code || sent.engagementId || '', duplicate: Boolean(sent.duplicate), reference, service }
  }
  return { ok: false, held: true, retry: sent.retry !== false, error: sent.error || 'the workspace did not answer', reference, service }
}

/** Reasons that are somebody's mistake and belong in the log as errors; the
    rest are ordinary traffic this branch exists to ignore. */
export const REFUSED_LOUDLY = new Set(['unknown-service', 'no-reference', 'incomplete'])

/**
 * The desk's notice for a paid invoice that opened nothing. `{ subject, text }`.
 *
 * This is the notice that was missing. A paid invoice with no service on it
 * — issued with the picker left on "No", or raised in the Stripe dashboard —
 * used to return 2xx-and-do-nothing, and the only way anyone found out was a
 * client asking where their engagement was. Now the desk is told, with the
 * one action that fixes it.
 */
export function untaggedPaidNotice(inv = {}, { origin = 'https://createspacebrand.com', reason = 'not-a-service' } = {}) {
  const number = inv.number || inv.id || 'an invoice'
  const who = [inv.customer_name, inv.customer_email].filter(Boolean).join(' · ') || 'an unnamed customer'
  const amount = money(Number(inv.amount_paid) || 0, inv.currency || 'usd')
  const tag = serviceTag(inv)
  const why = {
    'not-a-service': 'It has no service tagged on it, so no engagement was opened on the desk.',
    'unknown-service': `It is tagged with "${tag?.id || '?'}", which is not a service we sell, so no engagement was opened on the desk.`,
    'no-reference': 'It is tagged as a service but carries no reference, so no engagement was opened on the desk.',
    incomplete: 'It is tagged as a service but Stripe holds no name or no email for the customer, so no engagement was opened on the desk.',
  }[reason] || 'No engagement was opened on the desk.'

  return {
    subject: `Paid, not opened · invoice ${number} — ${who}`,
    text: [
      `Invoice ${number} was just paid: ${amount}, from ${who}.`,
      '',
      why,
      '',
      `If this payment is for a done-for-you service, open the engagement from the Billing tab — ${origin}/admin/ → Billing → find ${number} in the ledger → "Open the engagement". It tags the invoice, and the desk opens it exactly as a checkout would have.`,
      '',
      'If it is an ordinary invoice, nothing needs doing.',
      inv.description ? `\nMemo on the invoice: ${inv.description}` : '',
      inv.hosted_invoice_url ? `\n${inv.hosted_invoice_url}` : '',
    ].join('\n'),
  }
}

/** The desk's notice for a commission the bridge would not take. `{ subject, text }`. */
export function heldInvoiceNotice(inv = {}, { reference = '', error = '', origin = 'https://createspacebrand.com' } = {}) {
  const number = inv.number || inv.id || 'an invoice'
  const who = [inv.customer_name, inv.customer_email].filter(Boolean).join(' · ') || 'an unnamed customer'
  return {
    subject: `HELD · invoice ${number} paid, engagement not opened — ${who}`,
    text: [
      `Invoice ${number} was paid (${money(Number(inv.amount_paid) || 0, inv.currency || 'usd')}, ${who}) and its commission did not reach the workspace.`,
      '',
      `Reason: ${error || 'the workspace did not answer'}`,
      `Reference: ${reference}`,
      '',
      'It is held in the outbox and retried — by Stripe, by the next sale, and by "Send to the desk again" on the invoice in the Billing tab.',
      `If the reason names the signature, SERVICE_BRIDGE_SECRET differs between the two sites. ${origin}/admin/`,
    ].join('\n'),
  }
}
