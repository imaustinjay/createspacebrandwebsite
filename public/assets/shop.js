// The storefront's behaviour: the cart and its drawer, the Fall Drop
// countdown, the FAQ accordion, the three-step checkout, and every form on
// the new pages. One file, no build step, same as the rest of the site.
//
// Everything degrades: with JS off the pages still read and every link still
// navigates — only the cart, the countdown and the form submissions need it,
// and each of those says so in the markup it replaces.
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  // ---------------------------------------------------------------- catalog
  // The shelf, mirrored from the design's product data. The cart stores ids
  // only, so this is what turns an id back into a line the visitor can read.
  var CATALOG = {
    'start-small': {
      name: 'start small',
      tier: 'Digital product',
      delivery: 'PDF guide + 30-day tracker',
      href: '/shop/products/start-small/',
    },
    'aesthetic-kit': {
      name: 'the Aesthetic Kit',
      tier: 'Digital product · Flagship',
      delivery: 'DNG + Lightroom presets, Canva template links, PDF guide',
      href: '/shop/products/aesthetic-kit/',
    },
    'creator-planner': {
      name: 'the Creator Planner 2026',
      tier: 'Digital product',
      delivery: 'Printable PDF + Notion + Google Sheets',
      href: '/shop/products/creator-planner/',
    },
    'content-system': {
      name: 'the Content System',
      tier: 'Digital product',
      delivery: 'Notion workspace + PDF + Sheets calendar',
      href: '/shop/products/content-system/',
    },
    'starter-bundle': {
      name: 'the Creator Starter Bundle',
      tier: 'The Bundle',
      delivery: 'All four products, delivered together',
      href: '/shop/products/starter-bundle/',
    },
    'the-craft': {
      name: 'the craft — membership',
      tier: 'Membership · Recurring',
      delivery: 'Access opens August 17',
      href: '/shop/the-craft/',
    },
  }

  var CART_KEY = 'cs.cart'
  var ORDER_KEY = 'cs.order'
  var DETAILS_KEY = 'cs.checkout'
  var EMAIL_RE = /.+@.+\..+/

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
      '</div>'
    row.querySelector('.cart-item-name').textContent = p.name
    row.querySelector('.cart-item-tier').textContent = p.tier
    row.querySelector('.cart-remove').addEventListener('click', function () {
      removeFromCart(id)
    })
    return row
  }

  function render() {
    var cart = readCart()

    // The count in the header, on every page.
    document.querySelectorAll('.cart-count').forEach(function (el) {
      var was = el.textContent
      el.textContent = String(cart.length)
      if (was !== el.textContent && cartBtn) {
        cartBtn.setAttribute('data-bump', '')
        window.setTimeout(function () { cartBtn.removeAttribute('data-bump') }, 420)
      }
    })

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
        row.innerHTML = '<div><b></b><i></i></div><span>&mdash;</span>'
        row.querySelector('b').textContent = p.name
        row.querySelector('i').textContent = p.tier
        summary.insertBefore(row, mark)
      })
      var none = summary.querySelector('[data-summary-empty]')
      if (none) none.hidden = cart.length > 0
    }
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

  // ---------------------------------------------------------- account tabs
  var tabs = document.querySelector('.tabs')
  if (tabs) {
    var form = document.querySelector('[data-form="account"]')
    tabs.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-mode')
        tabs.querySelectorAll('button').forEach(function (b) {
          b.setAttribute('aria-selected', String(b === btn))
        })
        if (!form) return
        form.setAttribute('data-mode', mode)
        // The create-only fields leave the form entirely when logging in,
        // so their values can't be validated or sent by mistake.
        form.querySelectorAll('[data-create-only]').forEach(function (el) {
          el.hidden = mode !== 'create'
          el.querySelectorAll('input').forEach(function (i) { i.disabled = mode !== 'create' })
        })
        var cta = form.querySelector('[data-cta]')
        if (cta) cta.textContent = mode === 'create' ? 'Create my account' : 'Log in'
      })
    })
  }

  // ------------------------------------------------------------ input masks
  function fmtCard(v) {
    return v.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim()
  }
  function fmtExp(v) {
    var d = v.replace(/\D/g, '').slice(0, 4)
    return d.length > 2 ? d.slice(0, 2) + ' / ' + d.slice(2) : d
  }
  document.querySelectorAll('[data-fmt]').forEach(function (input) {
    var kind = input.getAttribute('data-fmt')
    input.addEventListener('input', function () {
      var before = input.value
      if (kind === 'card') input.value = fmtCard(before)
      else if (kind === 'exp') input.value = fmtExp(before)
      else if (kind === 'digits') input.value = before.replace(/\D/g, '').slice(0, 4)
    })
  })

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
  var checkout = document.querySelector('[data-checkout-flow]')
  if (checkout) {
    var steps = checkout.querySelectorAll('[data-step]')
    var chips = checkout.querySelectorAll('.steps > div')
    var method = 'card'
    var current = 1

    var saved = session(DETAILS_KEY) || {}
    ;['email', 'name', 'handle'].forEach(function (key) {
      var input = checkout.querySelector('[name="' + key + '"]')
      if (input && saved[key]) input.value = saved[key]
    })
    var craftBox = checkout.querySelector('[name="joinCraft"]')
    if (craftBox && typeof saved.joinCraft === 'boolean') craftBox.checked = saved.joinCraft

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
      var email = (checkout.querySelector('[name="email"]') || {}).value || ''
      var name = (checkout.querySelector('[name="name"]') || {}).value || ''
      if (n === 1) {
        if (!EMAIL_RE.test(email.trim())) return 'We need a working email — that’s where the files go.'
        if (!name.trim()) return 'Add a name for the receipt.'
        return null
      }
      if (n === 2 && method === 'card') {
        var card = (checkout.querySelector('[name="card"]') || {}).value || ''
        var exp = (checkout.querySelector('[name="exp"]') || {}).value || ''
        var cvc = (checkout.querySelector('[name="cvc"]') || {}).value || ''
        if (card.replace(/\D/g, '').length < 15) return 'That card number looks incomplete.'
        if (exp.replace(/\D/g, '').length < 4) return 'Add the expiry date.'
        if (cvc.length < 3) return 'Add the CVC from the back of the card.'
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
        email: ((checkout.querySelector('[name="email"]') || {}).value || '').trim(),
        name: ((checkout.querySelector('[name="name"]') || {}).value || '').trim(),
        handle: ((checkout.querySelector('[name="handle"]') || {}).value || '').trim(),
        joinCraft: craftBox ? craftBox.checked : true,
      })
    }

    function fillReview() {
      var details = session(DETAILS_KEY) || {}
      var last = ((checkout.querySelector('[name="card"]') || {}).value || '').replace(/\D/g, '').slice(-4)
      var labels = {
        email: details.email || '—',
        name: details.name || '—',
        method:
          method === 'card'
            ? 'Card •••• ' + (last || '—')
            : method === 'wallet'
              ? 'Apple / Google Pay'
              : 'Stripe Link',
        craft: details.joinCraft ? 'Joining the craft at launch' : 'Not joining yet',
      }
      checkout.querySelectorAll('[data-review]').forEach(function (el) {
        el.textContent = labels[el.getAttribute('data-review')]
      })
      var pay = checkout.querySelector('[data-pay]')
      if (pay) pay.textContent = details.joinCraft ? 'Pay securely & join the craft' : 'Pay securely'
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
        if (next === 3) fillReview()
        show(next)
      })
    })

    checkout.querySelectorAll('[data-method]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        method = btn.getAttribute('data-method')
        checkout.querySelectorAll('[data-method]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn))
        })
        checkout.querySelectorAll('[data-method-panel]').forEach(function (panel) {
          panel.hidden = panel.getAttribute('data-method-panel') !== method
        })
        setError(2, '')
        var to = checkout.querySelector('[data-link-email]')
        if (to) {
          var email = ((checkout.querySelector('[name="email"]') || {}).value || '').trim()
          to.textContent = email || 'your email'
        }
      })
    })

    var payBtn = checkout.querySelector('[data-pay]')
    if (payBtn) {
      payBtn.addEventListener('click', function () {
        var agreed = checkout.querySelector('[name="agreed"]')
        if (agreed && !agreed.checked) {
          setError(3, 'Please accept the terms before we take payment.')
          return
        }
        setError(3, '')
        var details = session(DETAILS_KEY) || {}
        session(ORDER_KEY, {
          id: 'CS-2026-' + String(1000 + Math.floor(Math.random() * 8999)),
          email: details.email || '',
          joinCraft: details.joinCraft !== false,
          items: readCart(),
        })
        // The cart is spent; the order is what carries forward. Card details
        // were never stored anywhere and go out of scope with this page.
        writeCart([])
        window.location.href = '/shop/order/'
      })
    }

    show(1)
  }

  // -------------------------------------------------- order confirmation
  var order = document.querySelector('[data-order]')
  if (order) {
    var placed = session(ORDER_KEY)
    var missing = order.querySelector('[data-order-missing]')
    var found = order.querySelector('[data-order-found]')

    if (!placed) {
      // Someone arrived here directly, or on another device. Say so plainly
      // rather than inventing an order.
      if (missing) missing.hidden = false
      if (found) found.hidden = true
    } else {
      if (missing) missing.hidden = true
      if (found) found.hidden = false
      order.querySelectorAll('[data-order-id]').forEach(function (el) {
        el.textContent = placed.id
      })
      order.querySelectorAll('[data-order-email]').forEach(function (el) {
        el.textContent = placed.email || 'your email'
      })
      var craftCopy = order.querySelector('[data-craft-copy]')
      if (craftCopy) {
        craftCopy.textContent = placed.joinCraft
          ? 'You opted in — your seat is reserved and you’ll be let in on August 17 when the doors open. Nothing more to pay until then.'
          : 'You skipped the membership, and that’s fine. The door stays open; your invitation is in your receipt.'
      }
      var files = order.querySelector('[data-files]')
      if (files) {
        // An empty cart at the desk still buys the Bundle's story — the
        // design falls back to it so the page is never a blank shelf.
        var ids = placed.items && placed.items.length ? placed.items : ['starter-bundle']
        ids.forEach(function (id) {
          var p = CATALOG[id]
          if (!p) return
          var row = document.createElement('div')
          row.className = 'file-row'
          // Disabled until the files exist: the copy above this list already
          // promises August 17, and a live-looking link that 404s would be
          // the one thing this page can't afford.
          row.innerHTML =
            '<div><b></b><i></i></div>' +
            '<button type="button" class="btn btn-secondary" disabled>Download</button>'
          row.querySelector('b').textContent = p.name
          row.querySelector('i').textContent = p.delivery
          files.appendChild(row)
        })
      }
    }
  }
})()
