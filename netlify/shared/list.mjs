// The list bridge — the storefront putting one person on the workspace's
// mailing list, and refusing to let that signup get lost.
//
// The same seam as a sale (commission.mjs): an HMAC over the exact bytes with
// the timestamp inside the signature, checked by the workspace against
// SERVICE_BRIDGE_SECRET, so nothing but our own pages can add an address.
// The workspace's end is netlify/functions/list-signup.mjs, reading the body
// through shared/mailingListCore.mjs — an address and a literal tick, or
// nothing. A signup the workspace cannot take right now (the bridge down, the
// table not yet on the database — it answers 503 for that on purpose) is
// HELD in its own outbox and flushed by the next signup or by hand.
//
// A row here carries consent as a literal `true`, never a truthy string, and
// the exact words the person agreed to. The workspace refuses anything else,
// and so does this file: a list built on an unticked box is not a list.
import { sign, bridgeSecret, workspaceUrl, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './commission.mjs'

/** The words beside the tick. Byte-identical to CONSENT_TEXT in the
    workspace's shared/mailingListCore.mjs — list.test.mjs holds the copy. */
export const CONSENT_TEXT = 'Yes — write to me from createspace: a few emails a season, and I can leave the list any time.'

const OUTBOX = 'list-signups'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const str = (v, max) => String(v ?? '').trim().slice(0, max)

/**
 * Shape one signup for the wire. Pure. `consent` survives only as a literal
 * true; everything else is trimmed to the workspace's own limits.
 */
export function signupFrom({ reference, email, name = '', handle = '', consent, source = 'assessment', tags = [], assessment = null, notes = '' }) {
  return {
    reference: str(reference, 40),
    email: str(email, 200).toLowerCase(),
    name: str(name, 120),
    handle: str(handle, 200),
    consent: consent === true,
    consentText: CONSENT_TEXT,
    source,
    tags: [...new Set((Array.isArray(tags) ? tags : []).map((t) => str(t, 40).toLowerCase()).filter(Boolean))].slice(0, 12),
    assessment: assessment && typeof assessment === 'object' ? assessment : null,
    notes: str(notes, 1000),
  }
}

async function outbox() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: OUTBOX, consistency: 'strong' })
  } catch (err) {
    console.error('list: outbox unavailable —', err?.message || err)
    return null
  }
}

/**
 * POST one signup, with retries. `{ ok }`, or `{ ok: false, retry, status,
 * error }` — `retry: false` is a verdict (a bad signature, no consent) that
 * sending again will never change.
 */
export async function postSignup(signup, { attempts = 3 } = {}) {
  if (signup.consent !== true) return { ok: false, retry: false, error: 'no consent — nothing to post' }
  const secret = bridgeSecret()
  if (!secret) return { ok: false, retry: true, error: 'SERVICE_BRIDGE_SECRET is not set on this deploy' }

  const body = JSON.stringify(signup)
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { signature, timestamp } = sign(body, secret)
    try {
      const res = await fetch(`${workspaceUrl()}/api/list-signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp },
        body,
      })
      if (res.ok) {
        const out = await res.json().catch(() => ({}))
        return { ok: true, existing: Boolean(out.existing), id: out.id || '' }
      }
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      // 503 is the workspace saying "not yet" (the table is not on the
      // database); that is worth holding for. 4xx is a verdict.
      const retry = res.status >= 500 || res.status === 429
      last = { ok: false, retry, status: res.status, error: detail || `the workspace answered ${res.status}` }
      if (!retry) return last
    } catch (err) {
      last = { ok: false, retry: true, error: String(err?.message || err).slice(0, 200) }
    }
    if (attempt < attempts - 1) await sleep(600 * (attempt + 1))
  }
  return last || { ok: false, retry: true, error: 'the workspace did not answer' }
}

/** Send it, and if it will not go, keep it. The function every caller uses. */
export async function deliverSignup(signup) {
  const result = await postSignup(signup)
  if (result.ok) {
    const store = await outbox()
    if (store) await store.delete(signup.reference).catch(() => {})
    console.log('list: delivered', signup.reference)
    return result
  }
  if (result.retry === false) {
    console.error('list: refused', signup.reference, '—', result.error)
    return result
  }
  const store = await outbox()
  if (store) {
    const held = (await store.get(signup.reference, { type: 'json' }).catch(() => null)) || {}
    await store
      .setJSON(signup.reference, { signup, tries: (Number(held.tries) || 0) + 1, lastError: result.error || '', heldAt: new Date().toISOString() })
      .catch((err) => console.error('list: could not hold —', err?.message || err))
  }
  console.error('list: HELD', signup.reference, '—', result.error)
  return { ...result, held: true }
}

/** Everything waiting, newest first. */
export async function heldSignups() {
  const store = await outbox()
  if (!store) return []
  try {
    const { blobs } = await store.list()
    const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: 'json' }).catch(() => null)))
    return rows.filter(Boolean).sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt)))
  } catch (err) {
    console.error('list: could not list the outbox —', err?.message || err)
    return []
  }
}

/** Try everything that is waiting — after each successful signup, and by hand. */
export async function flushListOutbox({ limit = 25 } = {}) {
  const store = await outbox()
  if (!store) return { flushed: 0, held: 0, skipped: 'no outbox' }
  const rows = (await heldSignups()).slice(0, limit)
  let flushed = 0
  for (const row of rows) {
    const out = await postSignup(row.signup, { attempts: 1 })
    if (out.ok || out.retry === false) {
      await store.delete(row.signup.reference).catch(() => {})
      if (out.ok) flushed += 1
    } else {
      await store.setJSON(row.signup.reference, { ...row, tries: (Number(row.tries) || 0) + 1, lastError: out.error || '', heldAt: new Date().toISOString() }).catch(() => {})
    }
  }
  return { flushed, held: rows.length - flushed }
}
