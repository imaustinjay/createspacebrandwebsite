// GET /api/order — read one order back, from Stripe, and hand over its files.
//
// The confirmation page used to invent an order out of sessionStorage: a
// random reference, no amount, and the same happy screen whether or not a
// payment had happened. This is the fix. The page shows what Stripe says and
// nothing else, so "Payment confirmed" is a fact rather than a layout.
//
//   /api/order?payment_intent=pi_…&payment_intent_client_secret=…
//   /api/order?setup_intent=seti_…&setup_intent_client_secret=…
//
// The client secret is the capability, and it is checked: knowing an intent
// id is not enough to read somebody's order. Stripe puts both on the return
// URL, so the buyer has them and nobody else does.
import { SHELF, money, siteOrigin, stripeClient } from '../shared/catalog.mjs'
import { deliverOrder } from '../shared/deliver.mjs'
import { deliverableCount, ensureOrder, manifests, markDelivered, orderByToken, readableSize } from '../shared/storage.mjs'
import { SERVICES } from '../shared/services.mjs'
import { commissionFromOrder, deliverCommission } from '../shared/commission.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }
const PAYMENT_RE = /^pi_[A-Za-z0-9]+$/
const SETUP_RE = /^seti_[A-Za-z0-9]+$/
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

// succeeded → the money is ours. processing → an asynchronous method is still
// clearing, which is neither a success to celebrate nor a failure to
// apologise for. Everything else means the buyer never finished.
function stateOf(status) {
  if (status === 'succeeded') return 'paid'
  if (status === 'processing') return 'processing'
  if (status === 'canceled') return 'unfinished'
  return 'unfinished'
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const params = new URL(req.url).searchParams

  // The permanent way back in. The receipt links here with the order's own
  // download token, so months later — on another device, in another browser —
  // the order still opens without Stripe's one-time return parameters.
  const permanent = params.get('token') || ''
  if (permanent) {
    if (!TOKEN_RE.test(permanent)) {
      return Response.json({ ok: false, reason: 'bad-intent' }, { status: 400, headers: NO_STORE })
    }
    const record = await orderByToken(permanent)
    if (!record) {
      return Response.json({ ok: false, reason: 'not-found' }, { status: 404, headers: NO_STORE })
    }
    // A token only ever exists for an order, and files are only attached to
    // one that was paid — so this door is always the confirmed view.
    return Response.json(await present(record, { state: 'paid', paid: true }), { headers: NO_STORE })
  }

  const paymentId = params.get('payment_intent') || ''
  const setupId = params.get('setup_intent') || ''
  const secret = params.get('payment_intent_client_secret') || params.get('setup_intent_client_secret') || ''

  const id = paymentId || setupId
  const isSetup = !paymentId && Boolean(setupId)
  const shapeOk = isSetup ? SETUP_RE.test(id) : PAYMENT_RE.test(id)
  if (!id || !shapeOk || id.length > 200 || !secret || secret.length > 400) {
    return Response.json({ ok: false, reason: 'bad-intent' }, { status: 400, headers: NO_STORE })
  }

  const stripe = stripeClient()
  if (!stripe) {
    return Response.json({ ok: false, reason: 'not-configured' }, { status: 503, headers: NO_STORE })
  }

  let intent
  try {
    intent = isSetup ? await stripe.setupIntents.retrieve(id) : await stripe.paymentIntents.retrieve(id)
  } catch (err) {
    const code = err?.statusCode === 404 || err?.code === 'resource_missing' ? 404 : 502
    if (code === 502) console.error('order: read failed —', err?.message || err)
    return Response.json(
      { ok: false, reason: code === 404 ? 'not-found' : 'unreachable' },
      { status: code, headers: NO_STORE }
    )
  }

  // The one check that matters: this browser holds the secret Stripe issued
  // for this intent. Without it an order id would be enough to read a
  // stranger's email address, and it isn't.
  if (intent.client_secret !== secret) {
    console.warn('order: client secret mismatch for', id)
    return Response.json({ ok: false, reason: 'not-found' }, { status: 404, headers: NO_STORE })
  }

  const state = stateOf(intent.status)
  const meta = intent.metadata || {}

  // Written at checkout, before the card was asked for — so it is here even
  // when the webhook hasn't run yet, and `ensureOrder` never mints a second
  // token for an order that already has one.
  const isService = meta.kind === 'service'
  const record = await ensureOrder(id, {
    reference: meta.reference || null,
    email: intent.receipt_email || null,
    name: meta.name || null,
    handle: meta.handle || '',
    joinCraft: meta.joinCraft !== 'no',
    items: isService ? [] : String(meta.cart || '').split(',').filter(Boolean),
    currency: intent.currency || 'usd',
    amount: typeof intent.amount === 'number' ? intent.amount : 0,
    kind: isService ? 'service' : isSetup ? 'membership' : 'one-time',
    ...(isService ? { service: meta.service || '', mode: meta.mode === 'deposit' ? 'deposit' : 'full', platform: meta.platform || '', niche: meta.niche || '', notes: meta.notes || '' } : {}),
  })

  // The second door, for a SERVICE. Same reasoning as the one below it and
  // higher stakes: a buyer whose commission never crossed is a buyer who paid
  // for a fortnight of work that nobody has started. If the webhook has not
  // managed it by the time they open their confirmation, this does — and the
  // workspace dedupes on the reference, so a race between the two doors opens
  // one engagement, not two.
  if (isService && state === 'paid' && !record.delivered) {
    const service = SERVICES[record.service]
    if (service) {
      console.warn('order: service paid but not commissioned — sending from the confirmation page', { reference: record.reference, intent: id })
      const answers = {}
      if (record.niche) answers['Your niche, in your own words'] = record.niche
      if (record.handle) answers['Your primary platform (and handle)'] = [record.platform, `@${record.handle}`].filter(Boolean).join(' · ')
      const sent = await deliverCommission(
        commissionFromOrder({ order: record, service, mode: record.mode, intent, answers, notes: record.notes || '' }),
      )
      if (sent.ok) {
        const next = await markDelivered(id, { via: 'order-page', engagement: sent.code || sent.engagementId || '' })
        if (next) Object.assign(record, next)
      }
    }
  }

  // The second door onto delivery.
  //
  // The webhook is the right way for a receipt to get sent, and normally it
  // has already done so by the time this page loads. But a webhook is the
  // piece most likely to be misconfigured on a launch day — wrong signing
  // secret, wrong URL, an unsubscribed event — and when it is, the payment
  // still succeeds and this page still works, so the only visible symptom is
  // a buyer who quietly never receives anything.
  //
  // So if an order is paid and still undelivered when its owner opens it,
  // deliver it here. `claimDelivery` makes sure only one door ever does.
  if (!isService && state === 'paid' && !record.delivered) {
    console.warn('order: paid but undelivered — sending from the confirmation page', {
      reference: record.reference,
      intent: id,
    })
    await deliverOrder({
      order: record,
      intent,
      stripe,
      origin: siteOrigin(req),
      trialOnly: isSetup,
      via: 'order-page',
    })
  }

  return Response.json(await present(record, { state, paid: state === 'paid', nothingDueToday: isSetup }), {
    headers: NO_STORE,
  })
}

// One order, as the confirmation page needs to read it. Both doors — Stripe's
// return parameters and the receipt's permanent token — land here, so the
// page renders identically whichever one the buyer came through.
async function present(record, { state, paid, nothingDueToday = false }) {
  // A service order has no files and never will. Its "delivery" is an
  // engagement on the desk and an assessment in the buyer's inbox, so the
  // page is told what to say instead of being handed an empty item list and
  // left to render a download section with nothing in it.
  if (record.kind === 'service') {
    const service = SERVICES[record.service] || null
    return {
      ok: true,
      state,
      paid,
      kind: 'service',
      free: false,
      reference: record.reference || null,
      email: record.email || null,
      name: record.name || null,
      joinCraft: record.joinCraft === true,
      total: typeof record.amount === 'number' ? money(record.amount, record.currency) : null,
      currency: record.currency || null,
      nothingDueToday: false,
      permalink: record.token ? `/shop/order/?token=${encodeURIComponent(record.token)}` : null,
      service: service
        ? {
            id: record.service,
            name: service.name,
            turnaround: service.turnaround,
            delivers: service.delivers,
            mode: record.mode === 'deposit' ? 'deposit' : 'full',
          }
        : null,
      // Whether the workspace has it. `false` on a paid order means the
      // commission is held in the outbox and retrying — the page says we are
      // on it, and the desk has already been told.
      opened: Boolean(record.delivered),
      engagement: record.engagement || '',
      items: [],
      anyReady: false,
      allReady: false,
    }
  }

  const ids = Array.isArray(record.items) ? record.items : []
  const shelves = await manifests(ids)

  // Links are only handed out once the payment is real. Everything else about
  // the order is readable while it clears; the files are not.
  const token = paid ? record.token : null
  const lineFor = (id) => (record.lines || []).find((l) => l.id === id)

  const items = ids.map((productId) => {
    const shelf = SHELF[productId]
    const entry = shelves[productId] || { files: [], links: [] }
    const line = lineFor(productId)
    const downloads = []
    if (token) {
      for (const file of entry.files) {
        downloads.push({
          label: file.label || file.name,
          size: readableSize(file.size),
          href: `/api/download?token=${encodeURIComponent(token)}&item=${encodeURIComponent(productId)}&file=${encodeURIComponent(file.name)}`,
        })
      }
      entry.links.forEach((link, i) => {
        downloads.push({
          label: link.label || 'Open',
          size: '',
          href: `/api/download?token=${encodeURIComponent(token)}&item=${encodeURIComponent(productId)}&link=${i}`,
          external: true,
        })
      })
    }
    return {
      id: productId,
      name: shelf ? shelf.name : productId,
      tier: shelf ? shelf.tier : '',
      delivery: shelf ? shelf.delivery : '',
      // Matches the receipt: nothing is "Free", not "$0".
      display: line ? (line.amount === 0 ? 'Free' : money(line.amount, record.currency)) : '',
      // "Coming" is a real state: the product is bought and paid for, the
      // files simply aren't uploaded yet. Saying so beats a dead button.
      ready: deliverableCount(entry) > 0,
      downloads,
    }
  })

  return {
    ok: true,
    state,
    paid,
    kind: record.kind || 'one-time',
    // Free is a kind of order, not a total of zero. The page says "free"
    // rather than "$0", which reads like a billing error even when it isn't.
    free: record.kind === 'free',
    reference: record.reference || null,
    email: record.email || null,
    name: record.name || null,
    joinCraft: record.joinCraft !== false,
    total: typeof record.amount === 'number' ? money(record.amount, record.currency) : null,
    currency: record.currency || null,
    // A membership on a trial has genuinely taken nothing today, and the page
    // has to be able to say that rather than print a total of nothing.
    nothingDueToday: nothingDueToday || record.amount === 0,
    // The permanent address for this order, for the page to offer as the way
    // back in — the same one the receipt carries.
    permalink: token ? `/shop/order/?token=${encodeURIComponent(token)}` : null,
    items,
    anyReady: items.some((i) => i.ready),
    allReady: items.length > 0 && items.every((i) => i.ready),
  }
}
