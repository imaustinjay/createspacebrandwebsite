// Delivering an order: the receipt to the buyer, the order to the house.
//
// This used to live inside the webhook, which made the webhook the only thing
// that could deliver — and a webhook is exactly the piece most likely to be
// misconfigured on a launch day. A wrong signing secret, an endpoint pointing
// at the wrong URL, an unsubscribed event, and the buyer silently gets
// nothing while the payment succeeds and the confirmation page works
// perfectly. That failure is invisible from the outside, which is the worst
// kind.
//
// So delivery moved here, and there are now two ways in:
//
//   · the webhook, which is the right one and usually wins by a second;
//   · /api/order, when a buyer opens their confirmation and the order still
//     hasn't been delivered.
//
// Both converge on one order record, one download token, and one delivery,
// because `claimDelivery` lets exactly one of them do the work.
import { SHELF, money } from './catalog.mjs'
import { mailbox, sendMail, table } from './mail.mjs'
import { cardLine, receiptDate, receiptEmail } from './receipt.mjs'
import { claimDelivery, deliverableCount, manifests, markDelivered, readableSize, releaseDelivery } from './storage.mjs'

// What each product actually delivers, right now. A product with nothing
// uploaded yet is not an error — it's a line that says "being finished"
// instead of a link that 404s.
export async function orderLines(order, origin) {
  const shelves = await manifests(order.items || [])
  return (order.items || []).map((id) => {
    const shelf = SHELF[id] || { name: id, delivery: '' }
    const entry = shelves[id] || { files: [], links: [] }
    const priced = (order.lines || []).find((l) => l.id === id)
    const links = [
      ...entry.files.map((f) => ({
        label: f.label || f.name,
        size: readableSize(f.size),
        href: `${origin}/api/download?token=${encodeURIComponent(order.token)}&item=${encodeURIComponent(id)}&file=${encodeURIComponent(f.name)}`,
      })),
      ...entry.links.map((l, i) => ({
        label: l.label || 'Open',
        size: '',
        href: `${origin}/api/download?token=${encodeURIComponent(order.token)}&item=${encodeURIComponent(id)}&link=${i}`,
      })),
    ]
    return {
      id,
      name: shelf.name,
      delivery: shelf.delivery,
      display: priced ? money(priced.amount, order.currency) : '',
      ready: deliverableCount(entry) > 0,
      links,
    }
  })
}

// The card on the receipt, and Stripe's own hosted copy as a footnote.
// Neither is worth failing a delivery over, so a miss here is just a miss.
async function paymentDetails(stripe, intent) {
  if (!stripe || !intent?.latest_charge) return { card: null, receiptUrl: '' }
  try {
    const charge = await stripe.charges.retrieve(
      typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge.id
    )
    return { card: charge.payment_method_details?.card || null, receiptUrl: charge.receipt_url || '' }
  } catch (err) {
    console.warn('deliver: could not read the charge for the receipt —', err?.message || err)
    return { card: null, receiptUrl: '' }
  }
}

/**
 * Deliver one paid order, once.
 *
 * Returns { delivered, reason, filesSent, retry } — `retry: true` means the
 * caller should hand the work back to Stripe rather than swallow it.
 *
 * `force` is the stockroom's "send it again": a person has asked for this
 * copy deliberately, so the once-only guards are the wrong answer. Everything
 * else about the send is identical, which is the point — what lands in the
 * buyer's inbox is the same email, not a hand-written apology.
 */
export async function deliverOrder({ order, intent, stripe, origin, trialOnly = false, via = 'webhook', force = false }) {
  if (!order || !order.items?.length) return { delivered: false, reason: 'no-order' }
  if (order.delivered && !force) return { delivered: false, reason: 'already' }

  // One of the two doors wins; the other walks away rather than sending a
  // second copy of the same receipt.
  const claimed = force || (await claimDelivery(order.intentId, via))
  if (!claimed) return { delivered: false, reason: 'in-flight' }

  try {
    const total = money(order.amount, order.currency)
    const lines = await orderLines(order, origin)
    const anyReady = lines.some((l) => l.ready)
    const orderUrl = `${origin}/shop/order/?token=${encodeURIComponent(order.token)}`
    const { card, receiptUrl } = trialOnly ? { card: null, receiptUrl: '' } : await paymentDetails(stripe, intent)

    const box = mailbox()
    if (!box) {
      // The payment is real and is in the Stripe dashboard either way — but
      // nobody hears about it and nobody gets their files, so say so loudly.
      // Not a retry: no number of them will configure SMTP.
      console.error('deliver: PAID BUT UNDELIVERED — no mailbox configured', {
        reference: order.reference,
        email: order.email,
        total,
      })
      await markDelivered(order.intentId, { notified: false, via })
      return { delivered: true, reason: 'no-mailbox', filesSent: false }
    }

    // ----------------------------------------------------- the house inbox
    const rows = [
      ['Reference', order.reference || '—'],
      ['Name', order.name || '—'],
      ['Email', order.email || '—'],
      ['Handle', order.handle || '—'],
      ['Items', lines.map((l) => `${l.name}${l.display ? ` (${l.display})` : ''}${l.ready ? '' : '  ← no files uploaded'}`).join('\n')],
      ['Total', trialOnly ? 'Nothing today — trial' : total],
      ['Paid with', cardLine(card) || '—'],
      ['Type', order.kind === 'membership' ? 'Membership (recurring)' : 'One-time'],
      ['the craft', order.joinCraft ? 'Yes — add them when the doors open' : 'Not joining'],
      ['Files', anyReady ? 'Sent' : 'None uploaded — upload them, then re-send'],
      ['Delivered by', via],
      ['Stripe intent', order.intentId],
    ]

    const internal = await sendMail({
      to: box.to,
      replyTo: order.email ? (order.name ? { name: order.name, address: order.email } : order.email) : undefined,
      subject: `Order ${order.reference || order.intentId} — ${trialOnly ? 'trial started' : total}${anyReady ? '' : ' — FILES MISSING'}`,
      text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
      html: table(rows, `Order ${order.reference || order.intentId}`),
    })

    // -------------------------------------------------------- the customer
    let confirmation = { ok: true }
    if (order.email) {
      confirmation = await sendMail({
        to: order.email,
        ...receiptEmail({
          reference: order.reference || order.intentId,
          firstName: (order.name || '').trim().split(/\s+/)[0] || 'there',
          lines,
          total,
          paidAt: receiptDate(intent?.created, process.env.SHOP_TIMEZONE),
          card,
          orderUrl,
          stripeReceiptUrl: receiptUrl,
          joinCraft: order.joinCraft,
          trialOnly,
          anyReady,
          supportEmail: box.to,
        }),
      })
    }

    if (internal.reason === 'send-failed' || confirmation.reason === 'send-failed') {
      // Transient. Let go of the claim so the next attempt — whichever door
      // it comes through — can pick the work up rather than skip it.
      console.error('deliver: the mailbox refused it', { reference: order.reference, via })
      await releaseDelivery(order.intentId)
      return { delivered: false, reason: 'send-failed', retry: true }
    }

    await markDelivered(order.intentId, { notified: true, filesSent: anyReady, via })
    console.log('deliver: sent', { reference: order.reference, total, files: anyReady, via })
    return { delivered: true, filesSent: anyReady }
  } catch (err) {
    console.error('deliver: failed —', err?.message || err)
    await releaseDelivery(order.intentId)
    return { delivered: false, reason: 'error', retry: true }
  }
}
