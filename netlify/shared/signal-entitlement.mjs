// SIGNAL's entitlement, written from the side that holds the money.
//
// The paywall's table lives in Supabase and is READ by the workspace app
// (createspace-workspace: shared/entitlementCore.mjs, shared/entitlementStore.mjs).
// It is WRITTEN here, because Stripe talks to this repo and only this repo.
// One table, one source of truth about who has paid, two codebases that meet
// at it.
//
// THE POLICY IS MIRRORED, INTENTIONALLY AND MINIMALLY. `TIERS` and the two
// readers below are a copy of the workspace's entitlementCore.mjs — the same
// arrangement creatorAccess.ts already has with creatorAccessCore.mjs, and
// for the same reason: two deploys, no shared package, so the small shared
// part is duplicated on purpose and kept honest by saying so. Change them
// together. Everything that DECIDES access stays over there; this file only
// decides what to write down.
//
// NO SDK, BY THE HOUSE PATTERN. customer-auth.mjs already speaks to Supabase
// over plain REST with the anon key rather than pulling in the client
// library — "no new secrets", and no new dependency. Same here, with the
// service-role key, because ws_sig_subscriptions has no insert or update
// policy at all: the only writers are this webhook and the founder's grant.
import { clean } from './catalog.mjs'

/** The tiers SIGNAL sells. Mirrors entitlementCore.mjs — change together. */
export const TIERS = ['free', 'starter', 'pro', 'studio']

function config() {
  const url = clean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL)
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  if (!url || !key) return null
  // The same tail-stripping customer-auth.mjs does: Stripe's dashboard and
  // Supabase's both show the project URL with a /rest/v1/ on it in places, and
  // a pasted tail turns every call into a doubled path and a 404 that looks
  // like anything but this.
  return { url: url.replace(/\/+$/, '').replace(/\/(rest|auth|storage|functions)\/v1$/i, ''), key }
}

/** Can entitlements be written at all? Missing config is reported, never assumed away. */
export const entitlementWritable = () => Boolean(config())

// One call to PostgREST. Returns { status, body } and never throws — the
// webhook decides what a failure means, because only it knows whether a
// Stripe retry would help.
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const cfg = config()
  if (!cfg) return { status: 0, body: null, reason: 'not-configured' }
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
  }
  if (prefer) headers.Prefer = prefer
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    return { status: res.status, body: parsed }
  } catch (err) {
    return { status: 0, body: null, reason: err?.message || 'unreachable' }
  }
}

/* ── reading Stripe's shapes ──────────────────────────────────────────────── */

/**
 * Which SIGNAL tier is this subscription for?
 *
 * §13 makes `tier` and `division` required metadata on every Price precisely
 * so this is never inferred from an amount.
 *
 * `signal_tier` is read FIRST and is what makes the bundle work: the craft +
 * SIGNAL pro bundle carries `tier: bundle` so the Financials Dashboard files
 * it as a bundle, and `signal_tier: pro` so this grants what it actually
 * sells. Without the second key a bundle subscriber pays and reaches nothing,
 * because `bundle` is not a tier the matrix knows.
 *
 * Returns null for the craft on its own, for a digital product, and for
 * anything else that is not SIGNAL — which is how those pass through
 * untouched.
 */
export function signalItem(subscription) {
  const items = subscription?.items?.data || []
  for (const item of items) {
    const meta = item?.price?.metadata || {}
    const named = meta.signal_tier ?? meta.tier ?? null
    if (TIERS.includes(named)) return { tier: named, item }
  }
  return null
}

export const signalTier = (subscription) => signalItem(subscription)?.tier ?? null

/**
 * A Stripe subscription, flattened into the row the table holds.
 * Mirrors entitlementFromStripe in entitlementCore.mjs — change together.
 *
 * WHERE THE PERIOD END LIVES. Stripe moved it: on the API version this repo
 * pins, the period belongs to the subscription ITEM and `current_period_end`
 * is absent from the subscription itself. catalog.mjs already carries the
 * scar from the last time a field moved unnoticed — `!invoice.subscription`
 * was permanently true and every membership renewal filed itself as an agency
 * invoice. Read both, prefer the top level, and treat finding neither as a
 * missing period rather than as zero, because zero is 1970 and 1970 reads as
 * a real, expired date.
 */
export function entitlementRow(subscription, tier, item = null) {
  if (!subscription || typeof subscription !== 'object') return null
  // WHICH item's period. This checkout puts every recurring line into ONE
  // subscription (checkout.mjs: `items: membership.map(...)`), so a cart
  // holding the craft AND a SIGNAL tier produces a two-item subscription —
  // and on the API version this repo pins, the period belongs to the item.
  // Reading data[0] blind would take the craft's period for SIGNAL's, which
  // are not the same date the moment one of them is added mid-cycle. Prefer
  // the item that actually matched SIGNAL.
  const line = item || subscription.items?.data?.[0] || null
  const epoch = subscription.current_period_end ?? line?.current_period_end ?? null
  const periodEnd = typeof epoch === 'number' && Number.isFinite(epoch)
    ? new Date(epoch * 1000).toISOString()
    : null
  const customer = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id ?? null

  return {
    source: 'stripe',
    tier: TIERS.includes(tier) ? tier : null,
    status: subscription.status ?? null,
    stripe_customer_id: customer,
    stripe_sub_id: subscription.id ?? null,
    current_period_end: periodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end === true,
    comp_expires_at: null,
    synced_at: new Date().toISOString(),
  }
}

/** Stripe counts in whole seconds. Mirrors eventTime in entitlementCore.mjs. */
export const eventTime = (event) =>
  typeof event?.created === 'number' && Number.isFinite(event.created)
    ? new Date(event.created * 1000).toISOString()
    : null

/**
 * Is this event older than what we already wrote?
 * Mirrors isFreshEvent in entitlementCore.mjs — change together.
 *
 * Stripe does not promise delivery in order. A retried `updated` can land
 * after the `deleted` that followed it in real time, and writing it blind
 * would reopen a cancelled subscription — quietly, and in the direction that
 * gives the product away.
 */
export function isFreshEvent(row, eventAt) {
  const read = (v) => {
    if (v === null || v === undefined || v === '') return null
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : null
  }
  const prev = read(row?.stripe_event_at)
  const next = read(eventAt)
  if (next === null) return prev === null
  if (prev === null) return true
  return next >= prev
}

/* ── finding the workspace this subscription belongs to ───────────────────── */

/**
 * The Supabase user behind an email address, via GoTrue's admin API.
 *
 * The FALLBACK path, and deliberately the weaker one. `cs_user` stamped at
 * checkout is the real link; an address is a claim on an account rather than
 * a proof of one, because addresses are shared, changed, and typed wrong.
 *
 * `filter` is GoTrue's own parameter and it matches loosely — so the result
 * is always confirmed against the exact address before it is used. If a
 * version of GoTrue ignores the filter entirely this returns null rather than
 * the first user on the list: a miss is recoverable by hand, and handing a
 * paid subscription to the wrong account is not.
 */
export async function userByEmail(email) {
  const cfg = config()
  const address = String(email || '').trim().toLowerCase()
  if (!cfg || !address) return null
  const res = await rest(`/auth/v1/admin/users?page=1&per_page=50&filter=${encodeURIComponent(address)}`)
  if (res.status !== 200) return null
  const users = Array.isArray(res.body?.users) ? res.body.users : Array.isArray(res.body) ? res.body : []
  const exact = users.filter((u) => String(u?.email || '').toLowerCase() === address)
  // Two accounts on one address should be impossible in GoTrue; if it ever
  // happens, choosing between them is not this function's call to make.
  return exact.length === 1 ? exact[0].id : null
}

/**
 * The creator workspace for a user, made if they have none.
 *
 * §6 puts provisioning on this side: the webhook creates the workspace so
 * that by the time the buyer lands in the portal there is somewhere for them
 * to be. `is_internal` is false and is never passed in — a workspace minted
 * by a payment is a creator workspace by definition, and leaving that to a
 * parameter is how it would one day be minted as an internal one.
 */
export async function workspaceForUser(userId, { name = '' } = {}) {
  if (!userId) return null
  const found = await rest(
    `/rest/v1/ws_sig_workspaces?owner_id=eq.${encodeURIComponent(userId)}&is_internal=is.false` +
    `&select=id,owner_id,is_internal&order=created_at.asc&limit=1`,
  )
  if (found.status === 200 && Array.isArray(found.body) && found.body[0]?.id) return found.body[0].id

  const made = await rest('/rest/v1/ws_sig_workspaces', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{ owner_id: userId, name: String(name || '').slice(0, 120), is_internal: false }],
  })
  if (made.status >= 200 && made.status < 300 && Array.isArray(made.body) && made.body[0]?.id) return made.body[0].id
  return null
}

/** What we already hold for a workspace, for the ordering check. */
export async function currentEntitlement(workspaceId) {
  const res = await rest(
    `/rest/v1/ws_sig_subscriptions?workspace_id=eq.${encodeURIComponent(workspaceId)}` +
    `&select=workspace_id,status,tier,stripe_sub_id,stripe_event_at&limit=1`,
  )
  if (res.status !== 200 || !Array.isArray(res.body)) return null
  return res.body[0] || null
}

/**
 * Write what Stripe just said.
 *
 * Idempotent by construction: the row is keyed on workspace, so a replayed
 * event rewrites identical values rather than stacking a second entitlement.
 * That is why there is no event ledger here — §13's replay requirement is met
 * by the shape of the table rather than by remembering every event id.
 *
 * Returns { ok, reason } and never throws; the webhook decides whether a
 * Stripe retry would help.
 */
export async function writeEntitlement(workspaceId, row, { eventAt = null, reason = '' } = {}) {
  if (!config()) return { ok: false, reason: 'not-configured', retry: false }
  if (!workspaceId) return { ok: false, reason: 'no-workspace', retry: false }
  if (!row?.tier) return { ok: false, reason: 'no-tier-metadata', retry: false }

  const before = await currentEntitlement(workspaceId)
  if (!isFreshEvent(before, eventAt)) {
    // Not an error. Stripe did its job; we simply already know something
    // newer, so nothing is rewritten and the webhook answers 2xx.
    return { ok: true, reason: 'stale-event', wrote: false }
  }

  const res = await rest('/rest/v1/ws_sig_subscriptions?on_conflict=workspace_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{
      workspace_id: workspaceId,
      ...row,
      stripe_event_at: eventAt,
      updated_at: new Date().toISOString(),
    }],
  })
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `write-failed:${res.status}`, retry: res.status === 0 || res.status >= 500, detail: res.body }
  }

  const after = Array.isArray(res.body) ? res.body[0] : res.body

  // Best effort. The audit row is a note ABOUT a change that has already
  // happened; losing it must not turn a written entitlement into a Stripe
  // retry storm that writes it again.
  rest('/rest/v1/ws_sig_ent_audit', {
    method: 'POST',
    body: [{
      workspace_id: workspaceId,
      actor_id: null,
      action: 'stripe_sync',
      before_state: before || {},
      after_state: after || {},
      reason,
    }],
  }).catch(() => {})

  return { ok: true, wrote: true, entitlement: after }
}
