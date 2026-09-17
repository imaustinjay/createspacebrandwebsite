// The page for a product that was added from the stockroom.
//
// Loaded only by /shop/products/generated/, which netlify.toml rewrites
// /shop/products/:id/ to when — and only when — no real page exists at that
// path. The rewrite is not forced, so every hand-built product page wins over
// this one, and a product can be "promoted" from generated to hand-built at
// any time by adding its file. Nothing migrates; the file simply starts
// winning.
//
// It fills itself from /api/catalog, which carries the shelf as well as the
// prices — the same read the cards and the checkout use, so a product cannot
// be one thing here and another at the till.
;(function () {
  'use strict'

  var root = document.querySelector('[data-gen-product]')
  var missing = document.querySelector('[data-gen-missing]')
  if (!root || !missing) return

  // /shop/products/<id>/ — the last non-empty segment.
  var parts = window.location.pathname.split('/').filter(Boolean)
  var id = parts.length ? parts[parts.length - 1] : ''

  function show(el) { if (el) el.hidden = false }
  function put(sel, text) {
    var el = document.querySelector(sel)
    if (el && text) el.textContent = text
  }
  function attr(sel, name, value) {
    var el = document.querySelector(sel)
    if (el && value) el.setAttribute(name, value)
  }

  function notFound() {
    show(missing)
  }

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: String(currency || 'usd').toUpperCase(),
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
      }).format(amount / 100)
    } catch (e) {
      return '$' + (amount / 100).toFixed(2)
    }
  }

  function fill(product, price) {
    var name = product.name || id
    var url = 'https://createspacebrand.com/shop/products/' + id + '/'

    document.title = name + ' | createspace'
    attr('[data-gen-canonical]', 'href', url)
    attr('[data-gen-ogurl]', 'content', url)
    attr('[data-gen-desc]', 'content', product.blurb || product.delivery || '')
    attr('[data-gen-ogdesc]', 'content', product.blurb || product.delivery || '')
    attr('[data-gen-ogtitle]', 'content', name + ' | createspace')

    put('[data-gen-crumb]', name)
    put('[data-gen-tier]', product.tier || 'Digital product')
    put('[data-gen-name]', name)
    put('[data-gen-blurb]', product.blurb || '')
    put('[data-gen-delivery]', product.delivery || '')

    // The bullets, built as nodes. This file never assigns innerHTML from
    // data: a product's words round-trip through a form and a blob store, and
    // a page is the wrong place to start trusting a string.
    var list = document.querySelector('[data-gen-inside]')
    var inside = Array.isArray(product.inside) ? product.inside : []
    if (list && inside.length) {
      inside.forEach(function (line) {
        var li = document.createElement('li')
        li.textContent = line
        list.appendChild(li)
      })
      show(document.querySelector('[data-gen-inside-wrap]'))
    }

    // The price, from the same answer. Written here rather than left to
    // shop.js: that file renders once at load, before this one has decided
    // which product the page is even about.
    var tag = document.querySelector('[data-gen-price]')
    if (tag) {
      tag.setAttribute('data-price', id)
      if (product.free) {
        tag.textContent = 'Free'
        tag.hidden = false
      } else if (price && typeof price.amount === 'number') {
        tag.textContent = price.display || money(price.amount, price.currency)
        tag.hidden = false
      }
      // No price and not free: the tag stays hidden. An em-dash is the house
      // rule — a product Stripe has no price for does not claim to have one.
    }

    var add = document.querySelector('[data-gen-add]')
    if (add) {
      // shop.js delegates its click handler, so setting this now is enough.
      add.setAttribute('data-add', id)
      if (product.free) add.textContent = 'Get it free'
    }

    show(root)
  }

  if (!id || !window.fetch) return notFound()

  fetch('/api/catalog', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      var shelf = (data && data.shelf) || {}
      var product = shelf[id]
      if (!product) return notFound()
      fill(product, (data && data.products && data.products[id]) || null)
    })
    .catch(function () {
      // The shelf is unreachable. Saying "not found" would be a guess; this
      // page has nothing true to show either way, so it says the honest thing
      // and points at the list that does work.
      notFound()
    })
})()
