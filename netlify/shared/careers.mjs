// The careers bridge — an application from /careers/ carried into the
// workspace's Talent Acquisition, and never lost on the way.
//
// The same seam as a sale and a list signup (commission.mjs, list.mjs): an
// HMAC over the exact bytes with the timestamp inside the signature, checked by
// the workspace against SERVICE_BRIDGE_SECRET. The workspace's end is
// netlify/functions/site-application.mjs, reading the body through
// shared/careersCore.mjs: it decides whether the submission is an application
// (the posting's window is open) or interest (it isn't yet, or any more), files
// it into ws_applications, and dedupes on our `reference`. A submission the
// workspace cannot take right now (the bridge down, a 5xx, the service key not
// set) is HELD in its own outbox and flushed by the next application or by hand.
import { sign, bridgeSecret, workspaceUrl, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './commission.mjs'

const OUTBOX = 'careers-applications'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A reference the workspace dedupes on — and the one the applicant is told. */
export const careersReference = () => `CS-APP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

/** The wire shape (pure). `submission` is readCareers()'s. */
export function applicationFrom(submission, reference) {
  return {
    reference,
    posting: submission.posting,
    kind: submission.kind,
    name: submission.name,
    email: submission.email,
    answers: submission.answers,
  }
}

async function outbox() {
  try {
    const { getStore } = await import('@netlify/blobs')
    return getStore({ name: OUTBOX, consistency: 'strong' })
  } catch (err) {
    console.error('careers: outbox unavailable —', err?.message || err)
    return null
  }
}

/**
 * POST one application, with retries. `{ ok, filed }`, or `{ ok: false, retry,
 * status, error }` — `retry: false` is a verdict (a bad signature, a body the
 * workspace refuses) that sending again will never change.
 */
export async function postApplication(app, { attempts = 3 } = {}) {
  const secret = bridgeSecret()
  if (!secret) return { ok: false, retry: true, error: 'SERVICE_BRIDGE_SECRET is not set on this deploy' }
  const body = JSON.stringify(app)
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { signature, timestamp } = sign(body, secret)
    try {
      const res = await fetch(`${workspaceUrl()}/api/site-application`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature, [TIMESTAMP_HEADER]: timestamp },
        body,
      })
      if (res.ok) {
        const out = await res.json().catch(() => ({}))
        return { ok: true, filed: out.filed || app.kind, duplicate: Boolean(out.duplicate), id: out.id || '' }
      }
      const detail = (await res.text().catch(() => '')).slice(0, 200)
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

/** Send it, and if it will not go, keep it. */
export async function deliverApplication(app) {
  const result = await postApplication(app)
  if (result.ok) {
    const store = await outbox()
    if (store) await store.delete(app.reference).catch(() => {})
    console.log('careers: delivered', app.reference, result.filed)
    return result
  }
  if (result.retry === false) {
    console.error('careers: refused', app.reference, '—', result.error)
    return result
  }
  const store = await outbox()
  if (store) {
    const held = (await store.get(app.reference, { type: 'json' }).catch(() => null)) || {}
    await store
      .setJSON(app.reference, { app, tries: (Number(held.tries) || 0) + 1, lastError: result.error || '', heldAt: new Date().toISOString() })
      .catch((err) => console.error('careers: could not hold —', err?.message || err))
  }
  console.error('careers: HELD', app.reference, '—', result.error)
  return { ...result, held: true }
}

/** Everything waiting, newest first. */
export async function heldApplications() {
  const store = await outbox()
  if (!store) return []
  try {
    const { blobs } = await store.list()
    const rows = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: 'json' }).catch(() => null)))
    return rows.filter(Boolean).sort((a, b) => String(b.heldAt).localeCompare(String(a.heldAt)))
  } catch (err) {
    console.error('careers: could not list the outbox —', err?.message || err)
    return []
  }
}

/** Try everything that is waiting — after each successful application, and by hand. */
export async function flushCareersOutbox({ limit = 25 } = {}) {
  const store = await outbox()
  if (!store) return { flushed: 0, held: 0, skipped: 'no outbox' }
  const rows = (await heldApplications()).slice(0, limit)
  let flushed = 0
  for (const row of rows) {
    const out = await postApplication(row.app, { attempts: 1 })
    if (out.ok || out.retry === false) {
      await store.delete(row.app.reference).catch(() => {})
      if (out.ok) flushed += 1
    } else {
      await store.setJSON(row.app.reference, { ...row, tries: (Number(row.tries) || 0) + 1, lastError: out.error || '', heldAt: new Date().toISOString() }).catch(() => {})
    }
  }
  return { flushed, held: rows.length - flushed }
}
