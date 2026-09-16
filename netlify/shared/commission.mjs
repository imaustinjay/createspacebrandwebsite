// The bridge — the storefront telling the workspace that somebody bought the
// work, and refusing to let that message get lost.
//
// A sale that does not reach the workspace is the worst failure this repo can
// have. The money is taken, the receipt is sent, the buyer is waiting, and
// nothing is happening — invisibly, because everything they can see worked.
// So this module is built around one promise: **a commission is delivered, or
// it is held until it can be.**
//
//   · Signed with an HMAC over the exact bytes, timestamp inside the signature
//     (shared/commissionCore.mjs in the workspace is the other end).
//   · Retried three times with a rising pause, for the ordinary blip.
//   · Held in a durable OUTBOX (Netlify Blobs) when it still will not go, and
//     flushed by the next commission, by the admin desk, or by hand.
//   · Never sent twice for the same reference — the workspace dedupes on it
//     too, so a double send is safe, and not sending twice is politeness.
//
// **Why a copy of the signing function.** The two sites are two repositories
// and there is no shared package between them. Four lines of HMAC is the
// smallest possible thing to duplicate, and the vector in the test file below
// is the same vector the workspace's own test asserts — so if either side ever
// changes how it signs, both test suites go red on the same commit.
import { createHmac } from 'node:crypto'
import { clean } from './catalog.mjs'

export const SIGNATURE_HEADER = 'x-cs-commission-signature'
export const TIMESTAMP_HEADER = 'x-cs-commission-timestamp'

/** The signed material is `${timestamp}.${body}` — the timestamp INSIDE the
    signature, so a replay cannot move it by editing a header. */
export function sign(body, secret, timestamp = Date.now()) {
  const ts = String(timestamp)
  return { timestamp: ts, signature: createHmac('sha256', String(secret)).update(`${ts}.${body}`).digest('hex') }
}

/** Where the workspace listens. Its own domain, from env — never derived from
    a request, and never guessed. */
export function workspaceUrl() {
  return clean(process.env.WORKSPACE_URL || 'https://createspacebrand.online').replace(/\/+$/, '')
}

/**
 * The secret this site SIGNS with.
 *
 * `SERVICE_BRIDGE_SECRET` may hold several, comma- or whitespace-separated —
 * that is what makes rotating one not an outage. But only the receiving side
 * gets to try them all; a signature is made with exactly one key, and this is
 * the side that makes it. So: **the first value in the list is the one we sign
 * with, and the workspace accepts any of them.**
 *
 * Rotating, in order, with the bridge up throughout:
 *   1. workspace:  SERVICE_BRIDGE_SECRET = "<old>, <new>"   (accepts both)
 *   2. storefront: SERVICE_BRIDGE_SECRET = "<new>"          (signs with new)
 *   3. workspace:  SERVICE_BRIDGE_SECRET = "<new>"          (drops old)
 *
 * Without the `[0]` below, a storefront holding "<new>, <old>" would sign with
 * the literal string "<new>, <old>" — which is not a key the workspace tries,
 * so EVERY commission would be refused with a 401 while both sites looked
 * correctly configured. That is a sale reaching the outbox instead of the desk.
 */
export const bridgeSecret = () => secretList()[0] || ''

/** Every secret configured here, in order. The first signs; the rest exist so
    a value can be staged before it is switched to. */
export function secretList() {
  return clean(process.env.SERVICE_BRIDGE_SECRET)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Is the bridge configured at all? The admin desk asks, so a misconfiguration
    is visible before a sale finds it rather than after. */
export const bridgeReady = () => Boolean(bridgeSecret() && workspaceUrl())

const OUTBOX = 'service-commissions'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function outbox() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: OUTBOX, consistency: 'strong' })
  } catch (err) {
    // Same degradation as the rest of this repo's storage: a bad afternoon at
    // Netlify must not turn a working payment into a 500. It IS logged loudly,
    // because an outbox that only lives in memory is an outbox that forgets.
    console.error('commission: outbox unavailable —', err?.message || err)
    return null
  }
}

/**
 * POST one commission, with retries.
 *
 * Returns `{ ok }` or `{ ok: false, retry, status, error }`. `retry: false`
 * means the workspace refused it on its merits — a bad signature, a service it
 * does not sell — and sending it again will never help; those are held for a
 * person rather than looped on.
 */
export async function postCommission(commission, { attempts = 3 } = {}) {
  const secret = bridgeSecret()
  if (!secret) return { ok: false, retry: true, error: 'SERVICE_BRIDGE_SECRET is not set on this deploy' }

  const body = JSON.stringify(commission)
  let last = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Re-signed each attempt: a retry after a long pause would otherwise carry
    // a timestamp outside the workspace's five-minute tolerance and be refused
    // for being old rather than for being wrong.
    const { signature, timestamp } = sign(body, secret)
    try {
      const res = await fetch(`${workspaceUrl()}/api/service-commission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp },
        body,
      })
      if (res.ok) {
        const out = await res.json().catch(() => ({}))
        return { ok: true, duplicate: Boolean(out.duplicate), code: out.code || '', engagementId: out.engagementId || '' }
      }
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      // 4xx is a verdict, not a blip. 401 means the two secrets differ, and
      // pounding the door three more times with the wrong key helps nobody.
      const retry = res.status >= 500 || res.status === 429
      last = { ok: false, retry, status: res.status, error: detail || `the workspace answered ${res.status}` }
      if (!retry) return last
    } catch (err) {
      last = { ok: false, retry: true, error: String(err?.message || err).slice(0, 200) }
    }
    if (attempt < attempts - 1) await sleep(700 * (attempt + 1))
  }
  return last || { ok: false, retry: true, error: 'the workspace did not answer' }
}

/**
 * Send it, and if it will not go, keep it.
 *
 * This is the function every caller should use. The outbox entry carries the
 * commission verbatim, the reason, and how many times we have tried — so the
 * admin desk can show "3 commissions waiting, the workspace is refusing the
 * signature" rather than a silence nobody can interpret.
 */
export async function deliverCommission(commission) {
  const result = await postCommission(commission)
  if (result.ok) {
    // A held copy that has now gone must not be flushed again later.
    const store = await outbox()
    if (store) await store.delete(commission.reference).catch(() => {})
    console.log('commission: delivered', commission.reference, '→', result.code || result.engagementId || 'ok')
    return result
  }

  const store = await outbox()
  if (store) {
    const held = (await store.get(commission.reference, { type: 'json' }).catch(() => null)) || {}
    await store
      .setJSON(commission.reference, {
        commission,
        tries: (Number(held.tries) || 0) + 1,
        lastError: result.error || '',
        retry: result.retry !== false,
        heldAt: new Date().toISOString(),
      })
      .catch((err) => console.error('commission: could not hold —', err?.message || err))
  }
  console.error('commission: HELD', commission.reference, '—', result.error)
  return { ...result, held: true }
}

/** Everything waiting, newest first. Read by the admin desk. */
export async function heldCommissions() {
  const store = await outbox()
  if (!store) return []
  try {
    const { blobs } = await store.list()
    const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: 'json' }).catch(() => null)))
    return rows
      .filter(Boolean)
      .sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt)))
  } catch (err) {
    console.error('commission: could not list the outbox —', err?.message || err)
    return []
  }
}

/**
 * Try everything that is waiting.
 *
 * Called after each successful sale (a working bridge is the best moment to
 * clear a backlog) and from the admin desk's "flush the outbox" button. Rows
 * the workspace refused on their merits are attempted too — a refused
 * signature becomes deliverable the moment somebody fixes the secret, which is
 * exactly when a flush gets pressed.
 */
export async function flushOutbox({ limit = 25 } = {}) {
  const store = await outbox()
  if (!store) return { flushed: 0, held: 0, skipped: 'no outbox' }
  const rows = (await heldCommissions()).slice(0, limit)
  let flushed = 0
  for (const row of rows) {
    if (!row?.commission?.reference) continue
    const r = await postCommission(row.commission, { attempts: 1 })
    if (r.ok) {
      await store.delete(row.commission.reference).catch(() => {})
      flushed += 1
    } else {
      await store
        .setJSON(row.commission.reference, { ...row, tries: (Number(row.tries) || 0) + 1, lastError: r.error || '', heldAt: new Date().toISOString() })
        .catch(() => {})
    }
  }
  return { flushed, held: rows.length - flushed }
}

/**
 * Shape one commission from an order.
 *
 * The workspace validates every field again on arrival (it does not trust this
 * side any more than this side trusts a browser), so the job here is only to
 * put the facts in the right boxes — and to be honest about which ones we do
 * not have. An empty handle is fine; a wrong one is not.
 */
export function commissionFromOrder({ order, service, mode = 'full', intent, kind = 'purchase', answers = {}, notes = '' }) {
  return {
    reference: order.reference,
    kind,
    serviceKey: service.serviceKey,
    serviceName: service.name,
    tier: service.tier,
    amount: typeof order.amount === 'number' ? order.amount : 0,
    // The whole fee, when this payment was only half of it. Stated rather than
    // inferred: the workspace would otherwise double the deposit, which is
    // right only while the deposit is exactly half.
    fullAmount: typeof order.fullAmount === 'number' && order.fullAmount > 0 ? order.fullAmount : 0,
    currency: order.currency || 'usd',
    payment: mode === 'deposit' ? 'deposit' : 'full',
    paidAt: new Date().toISOString(),
    client: {
      name: order.name || '',
      email: order.email || '',
      handle: order.handle || '',
      platform: order.platform || '',
      niche: order.niche || '',
      member: Boolean(order.joinCraft),
    },
    addons: [],
    discountPct: 0,
    answers,
    notes,
    source: 'createspacebrand.com',
    origin: intent?.id ? `stripe:${intent.id}` : '',
  }
}
