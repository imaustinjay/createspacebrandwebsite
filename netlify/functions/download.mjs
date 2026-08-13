// GET /api/download?token=…&item=<product>&file=<name>
// GET /api/download?token=…&item=<product>&link=<n>
//
// The door the receipt opens. The token is the entitlement: it is minted when
// a payment succeeds, it names exactly what was bought, and it is the only
// thing that gets a file out of storage. There is no path here that serves a
// product the token doesn't list, and no path that serves anything at all
// without one.
//
// The site promises "links don't expire", so they don't. What they do carry is
// a counter — a link handed round a group chat is visible in the log rather
// than invisible, and past a generous ceiling it stops.
import { SHELF } from '../shared/catalog.mjs'
import { getFile, manifest, orderByToken, saveOrder, safeName } from '../shared/storage.mjs'

const MAX_PER_ORDER = 200
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

function plain(status, message) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const params = new URL(req.url).searchParams
  const token = params.get('token') || ''
  const item = params.get('item') || ''
  const file = params.get('file') || ''
  const linkIndex = params.get('link')

  if (!TOKEN_RE.test(token)) {
    return plain(400, "That download link isn't complete. Open it straight from your receipt, or write to us and we'll send another.")
  }

  const order = await orderByToken(token)
  if (!order) {
    return plain(404, "We couldn't find an order for that link. Write to us with your order reference and a person will sort it out.")
  }

  // The entitlement check, and the only one that matters: this order bought
  // this product. A valid token for order A can never reach order B's files.
  if (!SHELF[item] || !(order.items || []).includes(item)) {
    console.warn('download: token asked for something it did not buy', { reference: order.reference, item })
    return plain(403, "That file isn't part of this order.")
  }

  const count = Number(order.downloads || 0) + 1
  if (count > MAX_PER_ORDER) {
    console.warn('download: ceiling reached', { reference: order.reference, count })
    return plain(429, "This link has been used a lot more than one person needs. Write to us and we'll reissue it.")
  }
  // Counted before the file is served: an interrupted download shouldn't
  // reset the count, and the count is a signal, not a quota to defend.
  await saveOrder({ ...order, downloads: count, lastDownloadAt: new Date().toISOString() })

  const entry = await manifest(item)

  // An external link — the escape hatch for anything too big to sensibly pass
  // through a function. Same token, same check, a redirect instead of bytes.
  if (linkIndex !== null) {
    const link = entry.links[Number(linkIndex)]
    if (!link || !link.url) return plain(404, 'That link is no longer here.')
    console.log('download: redirect', { reference: order.reference, item, label: link.label })
    return new Response(null, {
      status: 302,
      headers: { Location: link.url, 'Cache-Control': 'no-store' },
    })
  }

  const wanted = safeName(file)
  const meta = entry.files.find((f) => f.name === wanted)
  if (!meta) {
    // Bought, paid for, not uploaded yet — which is a different thing from
    // "not allowed", and the buyer deserves to be told which.
    return plain(
      404,
      "That file isn't ready to download yet. It unlocks the moment it's uploaded, and your link keeps working — nothing to do but check back."
    )
  }

  const stream = await getFile(item, wanted)
  if (!stream) {
    console.error('download: manifest lists a file storage does not have', { item, file: wanted })
    return plain(502, "We couldn't fetch that file just now. Try again in a moment — your link is fine.")
  }

  console.log('download: served', { reference: order.reference, item, file: wanted, count })

  return new Response(stream, {
    headers: {
      'Content-Type': meta.contentType || 'application/octet-stream',
      // Quoted and stripped of anything exotic upstream in safeName, so the
      // header can't be split and the browser saves it under its real name.
      'Content-Disposition': `attachment; filename="${wanted.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
