// The storefront's behaviour: the cart and its drawer, the live prices, the
// Fall Drop countdown, the FAQ accordion, the checkout handoff to Stripe, and
// every form on the new pages. One file, no build step, same as the rest of
// the site.
//
// Everything degrades: with JS off the pages still read and every link still
// navigates — only the cart, the prices, the countdown and the form
// submissions need it, and each of those says so in the markup it replaces.
//
// One rule this file follows without exception: **it never names a price.**
// Amounts arrive from /api/catalog, which reads them from Stripe, and the
// checkout sends product ids to /api/checkout, which resolves the amounts
// again server-side. A tampered cart can only ever buy things at their real
// price, so the cart is safe to keep in localStorage.
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  // ---------------------------------------------------------------- catalog
  // The shelf, mirrored from the design's product data. The cart stores ids
  // only, so this is what turns an id back into a line the visitor can read.
  // Price is deliberately absent — see the note above.
  var CATALOG = {
    'start-small': {
      name: 'start small',
      tier: 'Digital product',
      delivery: 'PDF guide + 30-day tracker',
      href: '/shop/products/start-small/',
      art: '01-cover',
    },
    'aesthetic-kit': {
      name: 'the Aesthetic Kit',
      tier: 'Digital product · Flagship',
      delivery: 'DNG + Lightroom presets, Canva template links, PDF guide',
      href: '/shop/products/aesthetic-kit/',
      art: '01-cover',
    },
    'creator-planner': {
      name: 'the Creator Planner 2026',
      tier: 'Digital product',
      delivery: 'Printable PDF + Notion + Google Sheets',
      href: '/shop/products/creator-planner/',
      art: '01-cover',
    },
    'content-system': {
      name: 'the Content System',
      tier: 'Digital product',
      delivery: 'Notion workspace + PDF + Sheets calendar',
      href: '/shop/products/content-system/',
      art: '01-cover',
    },
    'creator-audit': {
      name: 'the Creator Audit',
      tier: 'Free · Start here',
      delivery: 'PDF scoring sheet + your result',
      href: '/shop/products/creator-audit/',
      art: '01-cover',
      // Mirrors SHELF in netlify/shared/catalog.mjs. The price still comes
      // from /api/catalog like everything else — this only changes the words
      // on the buttons, because "Add to cart" is the wrong thing to say
      // about something that costs nothing.
      free: true,
    },
    'starter-bundle': {
      name: 'the Creator Starter Bundle',
      tier: 'The Bundle',
      delivery: 'All four products, delivered together',
      href: '/shop/products/starter-bundle/',
      art: '01-all-four',
    },
    'the-craft': {
      name: 'the craft — membership',
      tier: 'Membership · Recurring',
      delivery: 'Access opens August 17',
      href: '/shop/the-craft/',
    },
  }

  var CART_KEY = 'cs.cart'
  var DETAILS_KEY = 'cs.checkout'
  var EMAIL_RE = /.+@.+\..+/
  var DASH = '—'

  // Private browsing (and a full quota) make storage throw on write rather
  // than on read, so every access is guarded and simply falls back to a
  // cart that lives for the length of the page.
  var memoryCart = null

  function readCart() {
    if (memoryCart) return memoryCart.slice()
    try {
      var raw = window.localStorage.getItem(CART_KEY)
      var list = raw ? JSON.parse(raw) : []
      if (!Array.isArray(list)) return []
      return list.filter(function (id) { return Object.prototype.hasOwnProperty.call(CATALOG, id) })
    } catch (e) {
      return []
    }
  }

  function writeCart(list) {
    memoryCart = list.slice()
    try {
      window.localStorage.setItem(CART_KEY, JSON.stringify(list))
      memoryCart = null
    } catch (e) {
      /* held in memory for this page instead */
    }
    render()
  }

  function isFreeItem(id) {
    return Boolean(CATALOG[id] && CATALOG[id].free)
  }

  function addToCart(id) {
    if (!CATALOG[id]) return
    var list = readCart()
    if (list.indexOf(id) < 0) list.push(id)
    writeCart(list)
  }

  function removeFromCart(id) {
    writeCart(readCart().filter(function (c) { return c !== id }))
  }

  function session(key, value) {
    try {
      if (value === undefined) {
        var raw = window.sessionStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }
      if (value === null) window.sessionStorage.removeItem(key)
      else window.sessionStorage.setItem(key, JSON.stringify(value))
    } catch (e) {
      /* nothing to do — the flow works without the handoff, it just forgets */
    }
    return null
  }

  // ----------------------------------------------------------- live prices
  // null while unread, {} once we know there is nothing to show. The
  // difference matters: an unread price and a missing price both render as an
  // em-dash, and neither is ever rendered as zero.
  var PRICES = null

  // Set by the checkout so a late catalog still reaches a panel that was
  // already on screen — a slow network must not leave the pay button
  // permanently reading "—".
  var afterPrices = null

  // Currencies Stripe holds without a minor unit. Mirrors the server's list
  // in netlify/shared/catalog.mjs — the two format money identically so a
  // price reads the same on the page, in the summary and in the receipt.
  var ZERO_DECIMAL = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']

  function money(amount, currency) {
    if (typeof amount !== 'number' || !isFinite(amount)) return DASH
    var code = String(currency || 'usd').toLowerCase()
    var value = ZERO_DECIMAL.indexOf(code) >= 0 ? amount : amount / 100
    var whole = value % 1 === 0
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code.toUpperCase(),
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value)
    } catch (e) {
      return value.toFixed(whole ? 0 : 2) + ' ' + code.toUpperCase()
    }
  }

  function everyWord(recurring) {
    if (!recurring) return ''
    return recurring.count > 1 ? ' / ' + recurring.count + ' ' + recurring.interval + 's' : ' / ' + recurring.interval
  }

  function priceLabel(id) {
    var p = PRICES && PRICES[id]
    if (!p) return DASH
    return p.display + everyWord(p.recurring)
  }

  // The total, or null when it can't be known. A cart with one unpriced item
  // has no total — showing the sum of the rest would be a smaller, wrong
  // number, and a wrong number here is the worst thing on the page.
  function cartTotal(cart) {
    if (!PRICES || !cart.length) return null
    var sum = 0
    var currency = null
    var recurring = false
    for (var i = 0; i < cart.length; i++) {
      var p = PRICES[cart[i]]
      if (!p) return null
      if (currency && p.currency !== currency) return null
      currency = p.currency
      recurring = recurring || Boolean(p.recurring)
      sum += p.amount
    }
    return { amount: sum, currency: currency, display: money(sum, currency), recurring: recurring }
  }

  function loadCatalog() {
    if (!window.fetch) { PRICES = {}; return }
    fetch('/api/catalog', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(function (data) {
        PRICES = data && data.ok && data.products ? data.products : {}
      })
      .catch(function () {
        // Unreachable is not free: the em-dashes simply stay.
        PRICES = {}
      })
      .then(function () { render() })
  }

  // ------------------------------------------------------------ the drawer
  var drawer = document.querySelector('.cart-drawer')
  var scrim = document.querySelector('.cart-scrim')
  var cartBtn = document.querySelector('.cart-btn')
  var lastFocus = null

  function setDrawer(open) {
    if (!drawer) return
    if (open) {
      lastFocus = document.activeElement
      drawer.hidden = false
      if (scrim) scrim.hidden = false
      // A frame between "in the DOM" and "open" so the transition has a
      // from-state to run out of.
      window.requestAnimationFrame(function () {
        document.documentElement.setAttribute('data-cart-open', '')
      })
      var close = drawer.querySelector('.cart-close')
      if (close) close.focus()
    } else {
      document.documentElement.removeAttribute('data-cart-open')
      if (lastFocus && lastFocus.focus) lastFocus.focus()
      lastFocus = null
      // Wait out the slide before pulling it from the DOM.
      window.setTimeout(function () {
        if (document.documentElement.hasAttribute('data-cart-open')) return
        drawer.hidden = true
        if (scrim) scrim.hidden = true
      }, 340)
    }
  }

  function drawerOpen() {
    return document.documentElement.hasAttribute('data-cart-open')
  }

  // --------------------------------------------------------------- render
  // A product's cover, small — for the cart, the review step and the
  // confirmation. Returns null for anything with no art, so the striped square
  // stays put rather than becoming a broken image.
  //
  // Alt is deliberately empty: every one of these sits directly beside the
  // product's name in text, and a screen reader announcing the cover as well
  // would just say the same thing twice.
  function coverArt(id) {
    var p = CATALOG[id]
    if (!p || !p.art) return null
    // The cropped cut, not the full slide. These frames are 58–76px, and at
    // that size the slide's caption panel is half the square and legible to
    // nobody — so the small surfaces show the product itself.
    var base = '/assets/products/' + id + '/' + p.art + '-thumb'
    var picture = document.createElement('picture')
    var webp = document.createElement('source')
    webp.type = 'image/webp'
    webp.srcset = base + '.webp'
    var img = document.createElement('img')
    img.src = base + '.jpg'
    img.alt = ''
    img.width = 300
    img.height = 300
    img.loading = 'lazy'
    img.decoding = 'async'
    picture.appendChild(webp)
    picture.appendChild(img)
    return picture
  }

  function lineFor(id) {
    var p = CATALOG[id]
    var row = document.createElement('div')
    row.className = 'cart-item'
    row.innerHTML =
      '<div class="cart-item-shot"></div>' +
      '<div>' +
      '<div class="cart-item-name"></div>' +
      '<div class="cart-item-tier"></div>' +
      '<button type="button" class="cart-remove">Remove</button>' +
      '</div>' +
      '<div class="cart-item-price"></div>'
    var shot = coverArt(id)
    if (shot) row.querySelector('.cart-item-shot').appendChild(shot)
    row.querySelector('.cart-item-name').textContent = p.name
    row.querySelector('.cart-item-tier').textContent = p.tier
    row.querySelector('.cart-item-price').textContent = priceLabel(id)
    row.querySelector('.cart-remove').addEventListener('click', function () {
      removeFromCart(id)
    })
    return row
  }

  function render() {
    var cart = readCart()
    var total = cartTotal(cart)

    // The count in the header, on every page.
    document.querySelectorAll('.cart-count').forEach(function (el) {
      var was = el.textContent
      el.textContent = String(cart.length)
      if (was !== el.textContent && cartBtn) {
        cartBtn.setAttribute('data-bump', '')
        window.setTimeout(function () { cartBtn.removeAttribute('data-bump') }, 420)
      }
    })

    // Every price tag on the page — product cards, product pages, the craft.
    // A tag ships hidden and is only ever revealed by a real amount, so an
    // unread catalog shows no price rather than an empty one, and a product
    // Stripe has no price for simply doesn't claim to have one.
    if (PRICES) {
      document.querySelectorAll('[data-price]').forEach(function (el) {
        var p = PRICES[el.getAttribute('data-price')]
        if (!p) return
        el.textContent = priceLabel(el.getAttribute('data-price'))
        el.hidden = false
      })
      // And its opposite: copy that only holds while a price is unset.
      document.querySelectorAll('[data-no-price]').forEach(function (el) {
        if (PRICES[el.getAttribute('data-no-price')]) el.hidden = true
      })
    }

    // The drawer's own list.
    var body = drawer && drawer.querySelector('.cart-body')
    if (body) {
      var empty = body.querySelector('.cart-empty')
      body.querySelectorAll('.cart-item').forEach(function (el) { el.remove() })
      cart.forEach(function (id) { body.insertBefore(lineFor(id), empty) })
      if (empty) empty.hidden = cart.length > 0
    }
    var checkoutBtn = drawer && drawer.querySelector('[data-checkout]')
    if (checkoutBtn) checkoutBtn.hidden = cart.length === 0
    document.querySelectorAll('.cart-total span').forEach(function (el) {
      el.textContent = total ? total.display : DASH
    })

    // The checkout's order summary, when we're on that page.
    var summary = document.querySelector('[data-summary]')
    if (summary) {
      var mark = summary.querySelector('[data-summary-after]')
      summary.querySelectorAll('.summary-line[data-line]').forEach(function (el) { el.remove() })
      cart.forEach(function (id) {
        var p = CATALOG[id]
        var row = document.createElement('div')
        row.className = 'summary-line'
        row.setAttribute('data-line', '')
        row.innerHTML = '<div><b></b><i></i></div><span></span>'
        row.querySelector('b').textContent = p.name
        row.querySelector('i').textContent = p.tier
        row.querySelector('span').textContent = priceLabel(id)
        summary.insertBefore(row, mark)
      })
      var none = summary.querySelector('[data-summary-empty]')
      if (none) none.hidden = cart.length > 0
      summary.querySelectorAll('[data-summary-subtotal], [data-summary-total]').forEach(function (el) {
        el.textContent = total ? total.display : DASH
      })
    }

    if (afterPrices) afterPrices()
  }

  // ------------------------------------------------------------- the wiring
  if (cartBtn) cartBtn.addEventListener('click', function () { setDrawer(!drawerOpen()) })
  if (scrim) scrim.addEventListener('click', function () { setDrawer(false) })
  document.querySelectorAll('.cart-close').forEach(function (el) {
    el.addEventListener('click', function () { setDrawer(false) })
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawerOpen()) setDrawer(false)
  })

  // Every "Add to cart" on the site, wherever it sits. data-then="checkout"
  // is the design's "Buy it now" — add, then go straight to the desk.
  document.querySelectorAll('[data-add]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      addToCart(btn.getAttribute('data-add'))
      if (btn.getAttribute('data-then') === 'checkout') {
        window.location.href = '/shop/checkout/'
        return
      }
      setDrawer(true)
    })
  })

  document.querySelectorAll('[data-checkout]').forEach(function (btn) {
    btn.addEventListener('click', function () { window.location.href = '/shop/checkout/' })
  })

  render()

  // Prices are only worth a round trip on a page that shows one, or that
  // carries a cart with something in it.
  if (document.querySelector('[data-price], [data-summary], [data-checkout-flow]') || readCart().length) {
    loadCatalog()
  }

  // ------------------------------------------------------------- countdown
  // One ticking clock feeds the bar's compact reading and the drop's cells.
  var cdTargets = document.querySelectorAll('[data-countdown], [data-cd]')
  if (cdTargets.length) {
    var stamp = document.body.getAttribute('data-drop-date') || '2026-09-14T09:00:00-04:00'
    var target = new Date(stamp).getTime()
    var pad = function (n) { return String(n).padStart(2, '0') }

    var tick = function () {
      var left = Math.max(0, target - Date.now())
      var d = Math.floor(left / 864e5)
      var h = Math.floor(left / 36e5) % 24
      var m = Math.floor(left / 6e4) % 60
      var s = Math.floor(left / 1e3) % 60
      var parts = { d: pad(d), h: pad(h), m: pad(m), s: pad(s) }
      document.querySelectorAll('[data-countdown]').forEach(function (el) {
        el.textContent = d + 'd ' + pad(h) + 'h ' + pad(m) + 'm'
      })
      document.querySelectorAll('[data-cd]').forEach(function (el) {
        el.textContent = parts[el.getAttribute('data-cd')]
      })
    }
    tick()
    window.setInterval(tick, 1000)
  }

  // -------------------------------------------------------------- the FAQ
  // Native <details>, so it opens without JS and is findable by in-page
  // search. This only adds the design's accordion manner: one at a time.
  var faq = document.querySelector('.faq')
  if (faq) {
    var panels = Array.prototype.slice.call(faq.querySelectorAll('details'))
    panels.forEach(function (d) {
      d.addEventListener('toggle', function () {
        if (!d.open) return
        panels.forEach(function (other) { if (other !== d) other.open = false })
      })
    })
  }

  // --------------------------------------------------------- the gallery
  // Three shots per product: the cover, and two looks inside it. The big
  // frame already holds the cover from the HTML, so this only ever swaps
  // what's in it — with no JavaScript the page still shows the cover and the
  // thumbs are simply three more pictures of the product.
  //
  // The swap is a source swap rather than a re-render, so the browser reuses
  // whatever it already decoded and a second visit to a thumb is instant.
  var strip = document.querySelector('[data-gallery]')
  var frame = document.querySelector('[data-gallery-frame]')
  if (strip && frame) {
    var buttons = Array.prototype.slice.call(strip.querySelectorAll('button[data-shot]'))
    var big = frame.querySelector('picture')

    buttons.forEach(function (button) {
      // Pull what to show straight off the thumb's own <picture>, so the
      // markup stays the single source of truth for every path and size.
      var thumb = button.querySelector('picture')
      var thumbSource = thumb && thumb.querySelector('source')
      var thumbImg = thumb && thumb.querySelector('img')
      if (!thumbSource || !thumbImg || !big) return

      button.addEventListener('click', function () {
        var bigSource = big.querySelector('source')
        var bigImg = big.querySelector('img')
        if (!bigSource || !bigImg) return

        bigSource.srcset = thumbSource.srcset
        bigImg.src = thumbImg.src
        // The thumbs carry no alt — they are decorative repeats of what the
        // big frame shows. Its description comes from the button's label.
        bigImg.alt = (button.getAttribute('aria-label') || '').replace(/^Show:\s*/, '')
        // A newly-swapped image is above the fold by definition.
        bigImg.loading = 'eager'

        buttons.forEach(function (other) {
          other.setAttribute('aria-current', other === button ? 'true' : 'false')
        })
      })
    })

    // Arrow keys move along the strip, the way a set of related controls
    // should. Home and End jump to the ends of it.
    strip.addEventListener('keydown', function (event) {
      var at = buttons.indexOf(document.activeElement)
      if (at < 0) return
      var to = -1
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = (at + 1) % buttons.length
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = (at - 1 + buttons.length) % buttons.length
      else if (event.key === 'Home') to = 0
      else if (event.key === 'End') to = buttons.length - 1
      if (to < 0) return
      event.preventDefault()
      buttons[to].focus()
      buttons[to].click()
    })
  }

  // ---------------------------------------------------------- account tabs
  var tabs = document.querySelector('.tabs')
  if (tabs) {
    var accountForm = document.querySelector('[data-form="account"]')
    tabs.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-mode')
        tabs.querySelectorAll('button').forEach(function (b) {
          b.setAttribute('aria-selected', String(b === btn))
        })
        if (!accountForm) return
        accountForm.setAttribute('data-mode', mode)
        // The create-only fields leave the form entirely when logging in,
        // so their values can't be validated or sent by mistake.
        accountForm.querySelectorAll('[data-create-only]').forEach(function (el) {
          el.hidden = mode !== 'create'
          el.querySelectorAll('input').forEach(function (i) { i.disabled = mode !== 'create' })
        })
        var cta = accountForm.querySelector('[data-cta]')
        if (cta) cta.textContent = mode === 'create' ? 'Create my account' : 'Log in'
      })
    })
  }

  // ----------------------------------------------------------------- forms
  // Each form carries its own copy: data-msg on a field is the sentence the
  // design writes when that field is what's missing, so validation speaks in
  // the house voice rather than the browser's.
  function firstProblem(form) {
    var fields = form.querySelectorAll('input[data-msg], textarea[data-msg], select[data-msg]')
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i]
      if (f.disabled || f.closest('[hidden]')) continue
      var v = (f.value || '').trim()
      var min = Number(f.getAttribute('data-min') || 0)
      var bad =
        (f.type === 'checkbox' && !f.checked) ||
        (f.type !== 'checkbox' && !v) ||
        (f.type === 'email' && !EMAIL_RE.test(v)) ||
        (min > 0 && v.length < min)
      if (bad) return { field: f, message: f.getAttribute('data-msg') }
    }
    return null
  }

  function payload(form) {
    var out = { kind: form.getAttribute('data-form') }
    form.querySelectorAll('input, textarea, select').forEach(function (f) {
      if (!f.name || f.disabled) return
      if (f.type === 'checkbox') out[f.name] = f.checked
      else if (f.type === 'password') return // never leaves the browser
      else out[f.name] = f.value
    })
    return out
  }

  // Services sends people here with what they were reading about, so the
  // topic is already chosen when the form opens.
  var about = new URLSearchParams(window.location.search).get('about')
  if (about) {
    var topic = document.querySelector('[data-form="contact"] [name="topic"]')
    var wanted = { service: 'A done-for-you service', craft: 'the craft membership', order: 'An order or download', workshops: 'Workshops or cohorts', partnerships: 'Partnerships' }[about]
    if (topic && wanted) {
      Array.prototype.forEach.call(topic.options, function (o, i) {
        if (o.textContent === wanted) topic.selectedIndex = i
      })
    }
  }

  document.querySelectorAll('form[data-form]').forEach(function (form) {
    var openedAt = Date.now()
    var errorLine = form.querySelector('[data-error]')
    var button = form.querySelector('button[type="submit"]')
    var buttonLabel = button ? button.textContent : ''
    var done = document.getElementById(form.getAttribute('data-done') || '')

    function fail(message) {
      if (!errorLine) return
      errorLine.textContent = message
      errorLine.hidden = false
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      if (errorLine) errorLine.hidden = true

      var problem = firstProblem(form)
      if (problem) {
        fail(problem.message)
        problem.field.focus()
        return
      }

      var body = payload(form)
      if (button) {
        button.disabled = true
        button.textContent = 'Sending…'
      }
      body.website = (form.querySelector('input[name="website"]') || {}).value || ''
      body.elapsedMs = Date.now() - openedAt

      fetch('/api/shop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            if (!res.ok) throw new Error(data.error || 'send-failed')
            if (!done) return
            // Fill the confirmation's own copy from what was actually sent.
            done.querySelectorAll('[data-fill]').forEach(function (el) {
              var key = el.getAttribute('data-fill')
              if (key === 'firstName') {
                el.textContent = String(body.name || '').trim().split(/\s+/)[0] || 'friend'
              } else {
                el.textContent = body[key] || ''
              }
            })
            form.hidden = true
            done.hidden = false
            done.setAttribute('tabindex', '-1')
            done.focus({ preventScroll: true })
          })
        })
        .catch(function (err) {
          fail(
            err && err.message && err.message !== 'send-failed'
              ? err.message
              : "That didn't send — our side, not yours. Give it a moment and try again."
          )
          if (button) {
            button.disabled = false
            button.textContent = buttonLabel
          }
        })
    })
  })


  // -------------------------------------------------------------- checkout
  // Three steps, and all three of them are here: details, review, payment.
  // The payment fields belong to Stripe — they are an iframe, and the card
  // number never enters this document — but they are drawn in the house's own
  // type, colours and radii, inside our card, under our button. The buyer
  // never sees another domain, and there is still no card field in this repo.
  var checkout = document.querySelector('[data-checkout-flow]')
  if (checkout) {
    var steps = checkout.querySelectorAll('[data-step]')
    var chips = checkout.querySelectorAll('.steps > div')
    var current = 1

    var saved = session(DETAILS_KEY) || {}
    ;['email', 'name', 'handle'].forEach(function (key) {
      var input = checkout.querySelector('[name="' + key + '"]')
      if (input && saved[key]) input.value = saved[key]
    })
    var craftBox = checkout.querySelector('[name="joinCraft"]')
    if (craftBox && typeof saved.joinCraft === 'boolean') craftBox.checked = saved.joinCraft

    var params = new URLSearchParams(window.location.search)
    if (params.get('canceled')) {
      var canceledNote = checkout.querySelector('[data-canceled]')
      if (canceledNote) canceledNote.hidden = false
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', window.location.pathname)
      }
    }

    var field = function (name) {
      return ((checkout.querySelector('[name="' + name + '"]') || {}).value || '').trim()
    }

    function show(n) {
      current = n
      steps.forEach(function (panel) {
        panel.hidden = Number(panel.getAttribute('data-step')) !== n
      })
      chips.forEach(function (chip, i) {
        if (i + 1 <= n) chip.setAttribute('data-on', '')
        else chip.removeAttribute('data-on')
      })
      window.scrollTo(0, 0)
    }

    function problem(n) {
      if (n === 1) {
        if (!EMAIL_RE.test(field('email'))) return 'We need a working email — that’s where the files go.'
        if (!field('name')) return 'Add a name for the receipt.'
        if (!readCart().length) return 'Your cart is empty — add something before we take payment.'
        return null
      }
      if (n === 2) {
        var agreed = checkout.querySelector('[name="agreed"]')
        if (agreed && !agreed.checked) return 'Please accept the terms before we take payment.'
      }
      return null
    }

    function setError(n, message) {
      var line = checkout.querySelector('[data-step="' + n + '"] [data-error]')
      if (!line) return
      line.textContent = message || ''
      line.hidden = !message
    }

    function remember() {
      session(DETAILS_KEY, {
        email: field('email'),
        name: field('name'),
        handle: field('handle'),
        joinCraft: craftBox ? craftBox.checked : true,
      })
    }

    function fillReview() {
      var cart = readCart()
      var total = cartTotal(cart)
      var count = cart.length === 1 ? '1 item' : cart.length + ' items'
      var labels = {
        email: field('email') || DASH,
        name: field('name') || DASH,
        order: cart.length ? count + (total ? ' · ' + total.display : '') : 'Nothing in the cart',
        craft: craftBox && craftBox.checked ? 'Joining the craft at launch' : 'Not joining yet',
      }
      checkout.querySelectorAll('[data-review]').forEach(function (el) {
        var key = el.getAttribute('data-review')
        if (labels[key] !== undefined) el.textContent = labels[key]
      })

      // "Continue to payment" is the wrong sentence when there is nothing to
      // pay. Nothing else about the step changes — the terms still need
      // agreeing to, and the next press still writes a real order.
      var onward = checkout.querySelector('[data-step="2"] [data-goto="3"]')
      if (onward) {
        onward.textContent = cart.length && cart.every(isFreeItem) ? 'Get it — free' : 'Continue to payment'
      }

      // The covers, in cart order. Hidden entirely when nothing in the cart
      // has art, rather than left as a row of empty squares.
      var shots = checkout.querySelector('[data-review-shots]')
      if (shots) {
        shots.innerHTML = ''
        cart.forEach(function (id) {
          var art = coverArt(id)
          if (!art) return
          var frame = document.createElement('div')
          frame.appendChild(art)
          shots.appendChild(frame)
        })
        shots.hidden = shots.children.length === 0
      }
    }

    // ------------------------------------------------------ the pay panel
    var payBtn = checkout.querySelector('[data-pay]')
    var mountPoint = checkout.querySelector('[data-payment-element]')
    var stripe = null
    var elements = null
    var paymentElement = null
    var intent = null
    var mountedFor = ''
    var opening = false
    var confirming = false

    // What the payment was opened for. Change the cart, the email or the name
    // and it no longer matches — the intent is torn down and a new one opened,
    // so nobody can edit their order after the amount has been fixed.
    function signature() {
      return readCart().join(',') + '|' + field('email') + '|' + field('name')
    }

    function setPayState(state) {
      checkout.querySelectorAll('[data-pay-state]').forEach(function (el) {
        el.hidden = el.getAttribute('data-pay-state') !== state
      })
      if (payBtn) payBtn.disabled = state !== 'ready' || confirming
    }

    // The Payment Element is an iframe, so it can't inherit the page's CSS.
    // Instead it's handed the same design tokens the stylesheet uses, read
    // live off :root — change a token in site.css and the card field follows.
    function appearance() {
      var css = window.getComputedStyle(document.documentElement)
      var token = function (name, fallback) {
        return (css.getPropertyValue(name) || '').trim() || fallback
      }
      var seal = token('--seal', '#4E312C')
      var sage = token('--sage', '#567363')
      var border = token('--border', 'rgba(78, 49, 44, 0.14)')
      var faint = token('--faint', 'rgba(78, 49, 44, 0.40)')
      var muted = token('--muted', 'rgba(78, 49, 44, 0.55)')
      var label = {
        fontSize: '11px',
        fontWeight: '700',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: faint,
      }
      return {
        theme: 'flat',
        variables: {
          fontFamily: "'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
          fontSizeBase: '15px',
          colorPrimary: sage,
          colorBackground: token('--card', '#FFFFFF'),
          colorText: seal,
          colorTextSecondary: muted,
          colorTextPlaceholder: faint,
          colorDanger: '#A8443C',
          borderRadius: '11px',
          spacingUnit: '4px',
          spacingGridRow: '18px',
        },
        rules: {
          '.Input': {
            border: '1.5px solid ' + border,
            boxShadow: 'none',
            padding: '13px 15px',
            fontWeight: '400',
          },
          '.Input:focus': { border: '1.5px solid ' + sage, boxShadow: 'none', outline: 'none' },
          '.Input--invalid': { border: '1.5px solid #A8443C', boxShadow: 'none' },
          '.Label': label,
          '.Label--floating': label,
          '.Tab': { border: '1.5px solid ' + border, boxShadow: 'none', padding: '13px 16px' },
          '.Tab:hover': { border: '1.5px solid ' + sage, color: seal },
          '.Tab--selected': { border: '1.5px solid ' + sage, backgroundColor: token('--sage-tint', 'rgba(86,115,99,0.10)'), color: seal },
          '.Tab--selected:focus': { boxShadow: 'none' },
          '.TabLabel': { fontWeight: '600' },
          '.Error': { fontSize: '13px' },
          '.CheckboxInput': { borderRadius: '4px' },
        },
      }
    }

    function fillPayStep() {
      var total = intent ? { display: money(intent.dueToday, intent.currency), amount: intent.dueToday } : cartTotal(readCart())
      checkout.querySelectorAll('[data-pay-total]').forEach(function (el) {
        el.textContent = total ? total.display : DASH
      })
      // A membership that starts on a trial genuinely takes nothing today,
      // and the panel has to be able to say so rather than ask for $0.
      var free = Boolean(intent) && (intent.intentType === 'setup' || intent.dueToday === 0)
      checkout.querySelectorAll('[data-pay-free]').forEach(function (el) { el.hidden = !free })
      checkout.querySelectorAll('[data-pay-due]').forEach(function (el) { el.hidden = free })
      if (payBtn && !confirming) {
        payBtn.textContent = free
          ? 'Confirm and start'
          : total
            ? 'Pay ' + total.display + ' securely'
            : 'Pay securely'
      }
    }

    function teardown() {
      if (paymentElement) {
        try { paymentElement.unmount() } catch (e) { /* already gone */ }
        try { paymentElement.destroy() } catch (e) { /* already gone */ }
      }
      paymentElement = null
      elements = null
      intent = null
      mountedFor = ''
    }

    // Open a payment for what's in the cart right now, and mount Stripe's
    // fields into our card. Called on arriving at step 3, and again if
    // anything the amount depends on has changed since.
    function openPayment() {
      if (!mountPoint || opening || confirming) return
      var sig = signature()
      if (mountedFor === sig && paymentElement) {
        fillPayStep()
        setPayState('ready')
        return
      }
      if (!readCart().length) {
        setPayState('problem')
        setError(3, 'Your cart is empty — add something before we take payment.')
        return
      }

      teardown()
      opening = true
      setError(3, '')
      setPayState('loading')

      var details = session(DETAILS_KEY) || {}
      fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: readCart(),
          email: details.email || field('email'),
          name: details.name || field('name'),
          handle: details.handle || field('handle'),
          joinCraft: details.joinCraft !== false,
          agreed: true,
        }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            // Nothing to pay: the server has already written the order and
            // sent it. There is no card field to mount and no confirmation to
            // wait for, so go straight to the downloads.
            if (res.ok && data.free && data.orderUrl) {
              writeCart([])
              window.location.href = data.orderUrl
              return
            }
            if (!res.ok || !data.clientSecret) throw new Error(data.error || '')
            if (!window.Stripe) {
              // Stripe.js is the one thing on this page we don't serve. If a
              // network or a blocker ate it, say that rather than showing an
              // empty box where the card field should be.
              throw new Error(
                "The secure payment field couldn't load — an ad blocker or a strict network will do that. Try again, or write to us and we'll send a payment link."
              )
            }

            intent = data
            stripe = window.Stripe(data.publishableKey)
            elements = stripe.elements({
              clientSecret: data.clientSecret,
              appearance: appearance(),
              // The house typeface, handed to the iframe so the card field is
              // set in Raleway like everything around it.
              fonts: [{ cssSrc: window.location.origin + '/assets/fonts/fonts.css' }],
            })
            paymentElement = elements.create('payment', {
              layout: { type: 'tabs', defaultCollapsed: false },
              // Name and email were asked for on step 1; asking twice is the
              // sort of friction that loses a sale. They're passed straight
              // through on confirm instead.
              fields: { billingDetails: { name: 'never', email: 'never' } },
            })
            paymentElement.on('ready', function () {
              setPayState('ready')
            })
            paymentElement.on('loaderror', function (e) {
              setPayState('problem')
              setError(3, (e && e.error && e.error.message) || "The payment field couldn't load. Give it a moment and try again.")
            })
            paymentElement.mount(mountPoint)
            mountedFor = sig
            fillPayStep()
          })
        })
        .catch(function (err) {
          setPayState('problem')
          setError(
            3,
            (err && err.message) ||
              "We couldn't open the payment form — nothing was charged. Give it a moment and try again."
          )
        })
        .then(function () {
          opening = false
        })
    }

    checkout.querySelectorAll('[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = Number(btn.getAttribute('data-goto'))
        // Only forward moves are gated; Back never argues with you.
        if (next > current) {
          var message = problem(current)
          if (message) {
            setError(current, message)
            return
          }
        }
        setError(current, '')
        if (current === 1) remember()
        if (next === 2) fillReview()
        show(next)
        if (next === 3) openPayment()
      })
    })

    if (payBtn) {
      payBtn.addEventListener('click', function () {
        if (!stripe || !elements || !intent || confirming) return
        setError(3, '')
        remember()
        var details = session(DETAILS_KEY) || {}

        confirming = true
        payBtn.disabled = true
        var was = payBtn.textContent
        payBtn.textContent = 'Confirming…'

        var confirmParams = {
          // Stripe brings the buyer back here with the intent and its client
          // secret on the URL; /shop/order/ verifies both before showing an
          // order. Card, wallet and 3-D Secure all land in the same place.
          return_url: intent.returnUrl,
          payment_method_data: {
            billing_details: { name: details.name || '', email: details.email || '' },
          },
        }

        var confirmed =
          intent.intentType === 'setup'
            ? stripe.confirmSetup({ elements: elements, confirmParams: confirmParams })
            : stripe.confirmPayment({ elements: elements, confirmParams: confirmParams })

        confirmed
          .then(function (result) {
            // No error means the browser is already on its way to Stripe's
            // challenge or straight back to /shop/order/ — nothing to do.
            if (!result || !result.error) return
            var e = result.error
            setError(
              3,
              e.message ||
                (e.type === 'card_error' || e.type === 'validation_error'
                  ? 'Those details were declined. Try another card, or a different method.'
                  : "That didn't go through, and nothing was charged. Give it a moment and try again.")
            )
            confirming = false
            payBtn.disabled = false
            payBtn.textContent = was
          })
          .catch(function () {
            setError(3, "That didn't go through, and nothing was charged. Give it a moment and try again.")
            confirming = false
            payBtn.disabled = false
            payBtn.textContent = was
          })
      })
    }

    // Prices land after the first paint, and the cart can change from the
    // drawer while step 3 is open — redraw, and re-open the payment if what
    // it was opened for no longer matches.
    afterPrices = function () {
      if (current === 2) fillReview()
      if (current === 3) {
        fillPayStep()
        if (mountedFor && mountedFor !== signature()) openPayment()
      }
    }

    show(1)
    setPayState('loading')
    fillPayStep()
  }

  // -------------------------------------------------- order confirmation
  // Read back from Stripe, never from this browser. Two doors lead here: the
  // parameters Stripe adds on the way back from a payment, and the permanent
  // token in the receipt. Both are capabilities, both are checked server-side,
  // and neither can be guessed — so "Payment confirmed" means it was.
  var order = document.querySelector('[data-order]')
  if (order) {
    var panels = {
      loading: order.querySelector('[data-order-loading]'),
      missing: order.querySelector('[data-order-missing]'),
      found: order.querySelector('[data-order-found]'),
      pending: order.querySelector('[data-order-pending]'),
      unfinished: order.querySelector('[data-order-unfinished]'),
      problem: order.querySelector('[data-order-problem]'),
    }

    var showPanel = function (which) {
      Object.keys(panels).forEach(function (key) {
        if (panels[key]) panels[key].hidden = key !== which
      })
    }

    var q = new URLSearchParams(window.location.search)
    var query = ''
    if (q.get('token')) {
      query = 'token=' + encodeURIComponent(q.get('token'))
    } else if (q.get('payment_intent') && q.get('payment_intent_client_secret')) {
      query =
        'payment_intent=' + encodeURIComponent(q.get('payment_intent')) +
        '&payment_intent_client_secret=' + encodeURIComponent(q.get('payment_intent_client_secret'))
    } else if (q.get('setup_intent') && q.get('setup_intent_client_secret')) {
      query =
        'setup_intent=' + encodeURIComponent(q.get('setup_intent')) +
        '&setup_intent_client_secret=' + encodeURIComponent(q.get('setup_intent_client_secret'))
    }

    if (!query) {
      showPanel('missing')
    } else {
      showPanel('loading')
      fetch('/api/order?' + query, { headers: { Accept: 'application/json' } })
        .then(function (res) {
          return res.json().catch(function () { return {} }).then(function (data) {
            if (res.status === 404 || res.status === 400) return showPanel('missing')
            if (!res.ok || !data.ok) return showPanel('problem')
            if (data.state === 'unfinished') return showPanel('unfinished')

            // Paid, or clearing. Either way the cart is spent — leaving it
            // full would invite a second purchase of the same thing.
            writeCart([])

            order.querySelectorAll('[data-order-id]').forEach(function (el) {
              el.textContent = data.reference || DASH
            })
            order.querySelectorAll('[data-order-email]').forEach(function (el) {
              el.textContent = data.email || 'your email'
            })
            order.querySelectorAll('[data-order-total]').forEach(function (el) {
              el.textContent = data.free ? 'free' : data.nothingDueToday ? 'nothing today' : data.total || DASH
            })

            if (!data.paid) return showPanel('pending')

            // The headline changes with what actually happened: files in hand,
            // or files still being finished.
            order.querySelectorAll('[data-when-ready]').forEach(function (el) { el.hidden = !data.anyReady })
            order.querySelectorAll('[data-when-waiting]').forEach(function (el) { el.hidden = Boolean(data.anyReady) })

            var permalink = order.querySelector('[data-order-permalink]')
            if (permalink && data.permalink) {
              permalink.setAttribute('href', data.permalink)
              permalink.hidden = false
            }

            var craftCopy = order.querySelector('[data-craft-copy]')
            if (craftCopy) {
              craftCopy.textContent = data.joinCraft
                ? 'You opted in — your seat is reserved and you’ll be let in on August 17 when the doors open. Nothing more to pay until then.'
                : 'You skipped the membership, and that’s fine. The door stays open; your invitation is in your receipt.'
            }

            var files = order.querySelector('[data-files]')
            if (files) {
              files.innerHTML = ''
              ;(data.items || []).forEach(function (item) {
                var row = document.createElement('div')
                row.className = 'file-row'
                // The cover, so the thing just bought is recognisable as the
                // thing that was on the shelf a minute ago. The frame goes in
                // either way — striped when there's no art — so every row sits
                // on the same three columns.
                var frame = document.createElement('div')
                frame.className = 'file-shot'
                var shot = coverArt(item.id)
                if (shot) frame.appendChild(shot)
                row.appendChild(frame)
                var left = document.createElement('div')
                var b = document.createElement('b')
                b.textContent = item.name
                var i = document.createElement('i')
                i.textContent = item.delivery || ''
                left.appendChild(b)
                left.appendChild(i)
                row.appendChild(left)

                var actions = document.createElement('div')
                actions.className = 'file-actions'
                if (item.downloads && item.downloads.length) {
                  item.downloads.forEach(function (dl) {
                    var a = document.createElement('a')
                    a.className = 'btn btn-secondary'
                    a.setAttribute('href', dl.href)
                    // A real link, so it can be right-clicked, opened in a new
                    // tab, or resumed — everything a download ought to be.
                    if (!dl.external) a.setAttribute('download', '')
                    a.textContent = dl.size ? dl.label + ' · ' + dl.size : dl.label
                    actions.appendChild(a)
                  })
                } else {
                  var soon = document.createElement('span')
                  soon.className = 'file-soon'
                  soon.textContent = 'Being finished — we’ll email your link'
                  actions.appendChild(soon)
                }
                row.appendChild(actions)
                files.appendChild(row)
              })
            }

            showPanel('found')
          })
        })
        .catch(function () {
          showPanel('problem')
        })
    }
  }
})()
