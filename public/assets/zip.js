// A ZIP writer, in the browser, in about a hundred lines.
//
// The stockroom needs this because a product is often a folder — the Aesthetic
// Kit is a dozen presets and a guide — and handing a buyer twelve download
// buttons is a worse gift than handing them one. So the folder is zipped here,
// on the machine that has the files, and one archive is uploaded.
//
// Written by hand rather than pulled from a CDN, for the same reason the fonts
// are self-hosted: this site has no external dependency and no build step, and
// a storefront is not the place to start acquiring either. The format is
// PKZIP's original one — local header, data, central directory, end record —
// which every operating system has opened natively for thirty years.
//
// Compression is DEFLATE via the platform's own CompressionStream where it
// exists, and stored (uncompressed) where it doesn't, or where compressing
// made the file bigger — which is the usual outcome for the JPEGs, DNGs and
// PDFs this will mostly be given. A stored entry is a perfectly ordinary zip
// entry; nothing downstream can tell or cares.
//
// No zip64: the ceiling is 4 GB per file and 65,535 entries, and the upload
// endpoint stops at 40 MB long before either.
;(function (root) {
  'use strict'

  // Standard CRC-32, built once. Every entry carries one, and an unzipper
  // that finds the wrong one calls the archive corrupt — so this is the part
  // to get right rather than clever.
  var TABLE = (function () {
    var table = new Uint32Array(256)
    for (var i = 0; i < 256; i++) {
      var c = i
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    return table
  })()

  function crc32(bytes) {
    var c = 0xffffffff
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  function utf8(text) {
    return new TextEncoder().encode(text)
  }

  // MS-DOS packed time, which is what the format wants: two-second resolution
  // and an epoch of 1980. Anything outside that range is clamped rather than
  // allowed to wrap into a nonsense date.
  function stamp(ms) {
    var d = ms ? new Date(ms) : new Date()
    if (isNaN(d.getTime())) d = new Date()
    var year = Math.min(2107, Math.max(1980, d.getFullYear()))
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    }
  }

  async function deflateRaw(bytes) {
    if (typeof root.CompressionStream !== 'function') return null
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new root.CompressionStream('deflate-raw'))
      var packed = new Uint8Array(await new Response(stream).arrayBuffer())
      // Already-compressed formats come back bigger. Store those instead —
      // a zip whose entries are larger than the originals is an embarrassment.
      return packed.length < bytes.length ? packed : null
    } catch (e) {
      return null
    }
  }

  function concat(chunks) {
    var total = 0
    var i
    for (i = 0; i < chunks.length; i++) total += chunks[i].length
    var out = new Uint8Array(total)
    var at = 0
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], at)
      at += chunks[i].length
    }
    return out
  }

  // These names become paths on a stranger's disk when they unzip it, so a
  // leading slash or a `..` is not a formatting question. Strip both.
  function entryName(raw) {
    return String(raw || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(function (part) { return part && part !== '.' && part !== '..' })
      .join('/')
  }

  // entries: [{ name, bytes, modified }] → Uint8Array of a complete archive.
  async function zip(entries, onProgress) {
    var parts = []
    var central = []
    var offset = 0
    var count = 0

    for (var i = 0; i < entries.length; i++) {
      var name = entryName(entries[i].name)
      if (!name) continue
      var data = entries[i].bytes
      var crc = crc32(data)
      var packed = await deflateRaw(data)
      var method = packed ? 8 : 0
      var body = packed || data
      var nameBytes = utf8(name)
      var when = stamp(entries[i].modified)

      var local = new Uint8Array(30 + nameBytes.length)
      var lv = new DataView(local.buffer)
      lv.setUint32(0, 0x04034b50, true)
      lv.setUint16(4, 20, true) // version needed to extract
      lv.setUint16(6, 0x0800, true) // names are UTF-8
      lv.setUint16(8, method, true)
      lv.setUint16(10, when.time, true)
      lv.setUint16(12, when.date, true)
      lv.setUint32(14, crc, true)
      lv.setUint32(18, body.length, true)
      lv.setUint32(22, data.length, true)
      lv.setUint16(26, nameBytes.length, true)
      lv.setUint16(28, 0, true) // no extra field
      local.set(nameBytes, 30)
      parts.push(local, body)

      var record = new Uint8Array(46 + nameBytes.length)
      var cv = new DataView(record.buffer)
      cv.setUint32(0, 0x02014b50, true)
      cv.setUint16(4, 20, true) // version made by
      cv.setUint16(6, 20, true) // version needed
      cv.setUint16(8, 0x0800, true)
      cv.setUint16(10, method, true)
      cv.setUint16(12, when.time, true)
      cv.setUint16(14, when.date, true)
      cv.setUint32(16, crc, true)
      cv.setUint32(20, body.length, true)
      cv.setUint32(24, data.length, true)
      cv.setUint16(28, nameBytes.length, true)
      cv.setUint16(30, 0, true) // extra
      cv.setUint16(32, 0, true) // comment
      cv.setUint16(34, 0, true) // disk number
      cv.setUint16(36, 0, true) // internal attributes
      cv.setUint32(38, 0, true) // external attributes
      cv.setUint32(42, offset, true) // where its local header sits
      record.set(nameBytes, 46)
      central.push(record)

      offset += local.length + body.length
      count++
      if (onProgress) onProgress(count, entries.length)
    }

    var centralSize = 0
    for (var j = 0; j < central.length; j++) centralSize += central[j].length

    var end = new Uint8Array(22)
    var ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(4, 0, true) // this disk
    ev.setUint16(6, 0, true) // disk with the central directory
    ev.setUint16(8, count, true)
    ev.setUint16(10, count, true)
    ev.setUint32(12, centralSize, true)
    ev.setUint32(16, offset, true)
    ev.setUint16(20, 0, true) // no archive comment

    return concat(parts.concat(central, [end]))
  }

  root.csZip = { zip: zip, crc32: crc32, entryName: entryName }
})(typeof window !== 'undefined' ? window : globalThis)
