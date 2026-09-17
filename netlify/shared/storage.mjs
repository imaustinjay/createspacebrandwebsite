// Where the shop keeps things: the product files people buy, and the orders
// that entitle them to a copy.
//
// Netlify Blobs is the store. Three of them, each with one job:
//
//   product-files    the bytes, keyed `<productId>/<filename>`
//   product-shelf    one manifest per product — the files, their labels, and
//                    any external links, so a page renders from a single read
//   product-custom   products added from the stockroom rather than written
//                    into SHELF by hand — one record per product, and the
//                    reason a new product no longer needs a deploy
//   orders           an order, written twice: once under the payment intent
//                    that paid for it, once under the download token that
//                    opens it. Blobs has no secondary index, so both.
//
// Every read and write is wrapped: Blobs missing or unreachable degrades to an
// in-memory store for this instance rather than throwing, the same way the
// cart and the rate limiters already do. That keeps a bad afternoon at Netlify
// from turning a working payment into a 500 — but it is a fallback, not a
// place to keep anything, so it says so in the log.
import { randomBytes } from 'node:crypto'

const memory = new Map()

function memKey(store, key) {
  return store + '\u0000' + key
}

async function open(name) {
  try {
    const { getStore } = await import('@netlify/blobs')
    // Strong consistency: a file uploaded a second ago has to be downloadable
    // now, and an order written by the webhook has to be readable by the
    // confirmation page the buyer is already looking at.
    return getStore({ name, consistency: 'strong' })
  } catch (err) {
    console.error(`storage: ${name} unavailable, falling back to memory —`, err?.message || err)
    return null
  }
}

async function readJSON(storeName, key) {
  const store = await open(storeName)
  if (store) {
    try {
      return await store.get(key, { type: 'json' })
    } catch (err) {
      console.error(`storage: read ${storeName}/${key} failed —`, err?.message || err)
      return null
    }
  }
  return memory.get(memKey(storeName, key)) ?? null
}

async function writeJSON(storeName, key, value) {
  const store = await open(storeName)
  if (store) {
    try {
      await store.setJSON(key, value)
      return true
    } catch (err) {
      console.error(`storage: write ${storeName}/${key} failed —`, err?.message || err)
      return false
    }
  }
  memory.set(memKey(storeName, key), value)
  return true
}

// Blobs has no index, so "what orders are there" is a key listing. Only ever
// asked from behind the admin token — for the order store, and for the
// stockroom's own shelf of added products.
//
// `prefix` is required, not optional: the memory fallback builds its match
// from it, and an undefined one would match nothing while the Blobs path
// matched everything. Pass '' for the whole store.
async function listKeys(storeName, prefix) {
  const store = await open(storeName)
  if (store) {
    try {
      const { blobs } = await store.list({ prefix })
      return (blobs || []).map((b) => b.key)
    } catch (err) {
      console.error(`storage: list ${storeName}/${prefix} failed —`, err?.message || err)
      return []
    }
  }
  const head = memKey(storeName, prefix)
  return [...memory.keys()].filter((k) => k.startsWith(head)).map((k) => k.slice(storeName.length + 1))
}

async function removeKey(storeName, key) {
  const store = await open(storeName)
  if (store) {
    try {
      await store.delete(key)
      return true
    } catch (err) {
      console.error(`storage: delete ${storeName}/${key} failed —`, err?.message || err)
      return false
    }
  }
  return memory.delete(memKey(storeName, key))
}

// ------------------------------------------------------------- the shelf
// A product's manifest: what a buyer of it actually receives.
//
//   { files: [{ name, label, size, contentType, uploadedAt }],
//     links: [{ label, url, addedAt }] }
//
// `files` are held here; `links` point somewhere else the owner already keeps
// them. Both exist because a 200 MB preset pack is a bad fit for a serverless
// response and a good fit for a link, and neither should be the only option.
const SHELF_STORE = 'product-shelf'
const FILE_STORE = 'product-files'
const EMPTY = { files: [], links: [] }

export async function manifest(productId) {
  const found = await readJSON(SHELF_STORE, productId)
  if (!found) return { ...EMPTY }
  return { files: Array.isArray(found.files) ? found.files : [], links: Array.isArray(found.links) ? found.links : [] }
}

export async function manifests(productIds) {
  const out = {}
  await Promise.all(
    productIds.map(async (id) => {
      out[id] = await manifest(id)
    })
  )
  return out
}

// How many things a product delivers — the number the pages and the emails
// branch on. Zero means "not uploaded yet", which is a real state and is said
// plainly rather than shown as a broken link.
export function deliverableCount(entry) {
  if (!entry) return 0
  return (entry.files?.length || 0) + (entry.links?.length || 0)
}

export async function putFile(productId, name, body, { label, contentType, size } = {}) {
  const store = await open(FILE_STORE)
  const key = `${productId}/${name}`
  if (store) {
    try {
      await store.set(key, body, { metadata: { productId, name, contentType: contentType || '' } })
    } catch (err) {
      console.error('storage: file upload failed —', err?.message || err)
      return { ok: false, error: 'upload-failed' }
    }
  } else {
    memory.set(memKey(FILE_STORE, key), body)
  }

  const entry = await manifest(productId)
  entry.files = entry.files.filter((f) => f.name !== name)
  entry.files.push({
    name,
    label: label || name,
    size: Number(size) || 0,
    contentType: contentType || 'application/octet-stream',
    uploadedAt: new Date().toISOString(),
  })
  await writeJSON(SHELF_STORE, productId, entry)
  return { ok: true, file: entry.files[entry.files.length - 1] }
}

export async function getFile(productId, name) {
  const key = `${productId}/${name}`
  const store = await open(FILE_STORE)
  if (store) {
    try {
      // A stream, not a buffer: a function that reads a 40 MB file into memory
      // before answering is one that eventually doesn't answer.
      return await store.get(key, { type: 'stream' })
    } catch (err) {
      console.error('storage: file read failed —', err?.message || err)
      return null
    }
  }
  return memory.get(memKey(FILE_STORE, key)) ?? null
}

export async function removeFile(productId, name) {
  await removeKey(FILE_STORE, `${productId}/${name}`)
  const entry = await manifest(productId)
  entry.files = entry.files.filter((f) => f.name !== name)
  await writeJSON(SHELF_STORE, productId, entry)
  return { ok: true }
}

export async function setLinks(productId, links) {
  const entry = await manifest(productId)
  entry.links = links.map((l) => ({
    label: String(l.label || 'Download').slice(0, 120),
    url: String(l.url || '').slice(0, 2000),
    addedAt: l.addedAt || new Date().toISOString(),
  }))
  await writeJSON(SHELF_STORE, productId, entry)
  return entry
}

// ------------------------------------------------------- the custom shelf
// A product somebody added from the stockroom. The seven in SHELF are written
// in code because each has a hand-built page, bespoke photography and copy
// nobody would want a form to collect. These are the others: everything the
// shop needs to list one, sell it, deliver it and give it a page.
//
// Blobs has no index, so the whole shelf is a key listing plus a read each.
// That is fine at this size — a shop with hundreds of products would want a
// single manifest key instead, and this can become that without the callers
// noticing, because they only ever see the merged object.
const CUSTOM_STORE = 'product-custom'

/** Every stockroom-added product, keyed by id, in the shape SHELF uses. */
export async function customProducts() {
  const keys = await listKeys(CUSTOM_STORE, '')
  const out = {}
  await Promise.all(
    keys.map(async (key) => {
      const row = await readJSON(CUSTOM_STORE, key)
      if (row && row.id && row.name) out[row.id] = row
    })
  )
  return out
}

export async function putCustomProduct(entry) {
  await writeJSON(CUSTOM_STORE, entry.id, entry)
  return entry
}

export async function removeCustomProduct(id) {
  await removeKey(CUSTOM_STORE, id)
  return { ok: true }
}

// ------------------------------------------------------------- the orders
// The record that turns a payment into an entitlement. Written by whichever
// of the webhook and the confirmation page gets there first — they converge
// on the same token because both key it by the payment intent.
const ORDER_STORE = 'orders'

export function newToken() {
  return randomBytes(24).toString('base64url')
}

export const orderKey = (intentId) => `by-intent/${intentId}`
export const tokenKey = (token) => `by-token/${token}`

export async function orderByIntent(intentId) {
  return readJSON(ORDER_STORE, orderKey(intentId))
}

export async function orderByToken(token) {
  return readJSON(ORDER_STORE, tokenKey(token))
}

export async function saveOrder(record) {
  await writeJSON(ORDER_STORE, orderKey(record.intentId), record)
  if (record.token) await writeJSON(ORDER_STORE, tokenKey(record.token), record)
  return record
}

// Get the order for an intent, or create it. Idempotent by construction: the
// second caller finds the first caller's token instead of minting a second
// one, so the buyer's links are the same links whichever page or webhook ran
// first.
export async function ensureOrder(intentId, seed) {
  const existing = await orderByIntent(intentId)
  if (existing) return existing
  const record = {
    intentId,
    token: newToken(),
    createdAt: new Date().toISOString(),
    delivered: false,
    ...seed,
  }
  await saveOrder(record)
  return record
}

// The last N orders, newest first — the stockroom's ledger.
//
// This exists because "did the receipt go out?" was, until now, a question you
// could only answer by reading a function log in another dashboard. An order
// record already carries the answer; it just had nowhere to be seen.
export async function recentOrders(limit = 25) {
  const keys = await listKeys(ORDER_STORE, 'by-intent/')
  const records = await Promise.all(keys.map((key) => readJSON(ORDER_STORE, key)))
  return records
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, limit)
}

// Delivery can be reached from two directions — the webhook and the
// confirmation page — and both may arrive within the same second. This is the
// lease that lets exactly one of them do the work.
//
// It is a claim, not a lock: Blobs has no compare-and-set, so a genuinely
// simultaneous pair could in principle both win. The window is milliseconds
// and the cost is one duplicate receipt, which is a far smaller failure than
// the one this exists to prevent — a buyer who gets nothing because the only
// door was misconfigured. The claim expires so a crashed attempt can't wedge
// an order shut forever.
const CLAIM_TTL_MS = 3 * 60 * 1000

export async function claimDelivery(intentId, via) {
  const record = await orderByIntent(intentId)
  if (!record || record.delivered) return false
  const held = record.claimedAt ? Date.parse(record.claimedAt) : 0
  if (held && Date.now() - held < CLAIM_TTL_MS) return false
  await saveOrder({ ...record, claimedAt: new Date().toISOString(), claimedBy: via || 'unknown' })
  return true
}

// Let go, so a failed attempt doesn't hold the order shut until the lease
// runs out. Anything that returns `retry` calls this on its way out.
export async function releaseDelivery(intentId) {
  const record = await orderByIntent(intentId)
  if (!record) return
  const next = { ...record }
  delete next.claimedAt
  delete next.claimedBy
  await saveOrder(next)
}

export async function markDelivered(intentId, patch = {}) {
  const record = await orderByIntent(intentId)
  if (!record) return null
  const next = { ...record, ...patch, delivered: true, deliveredAt: new Date().toISOString() }
  await saveOrder(next)
  return next
}

// A human size for a download button — "2.4 MB", not "2516582".
export function readableSize(bytes) {
  const n = Number(bytes)
  if (!n || !isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let value = n
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return (value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[i]
}

// Filenames come from an upload form and end up in a blob key and a
// Content-Disposition header. Keep them boring.
export function safeName(raw) {
  return String(raw || '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
