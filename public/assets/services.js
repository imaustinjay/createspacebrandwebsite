/* ─────────────────────────────────────────────────────────────────────────
   /shop/services/ — the done-for-you shelf, and the two ways of starting one.

   The product shop is a cart: add things, go to a checkout, pay for all of
   them. A service is not a cart. You buy exactly one, it takes a fortnight,
   and the thing you actually need at the till is not a basket — it is three
   facts about you so the first email does not read like a form letter.

   So this page books rather than carts:

     Tier 03 — a fixed-price build. A short form, then Stripe's Payment
               Element right here, then the confirmation page.
     Tier 04 — scoped in writing before a price exists (the catalog's own
               rule). "Request the scope of work" opens a real engagement on
               the desk, and the assessment reaches them in a minute.

   Prices are read from /api/services and are em-dashes until it answers —
   the same promise the product shelf makes, for the same reason: a wrong
   price is worse than no price.

   ES5-ish on purpose, like the rest of /assets: no build step in this repo.
   ───────────────────────────────────────────────────────────────────────── */
;(function () {
  'use strict'

  var DASH = '—'
  var root = document.querySelector('[data-services]')
  if (!root) return

  var listEl = root.querySelector('[data-service-list]')
  var panel = document.querySelector('[data-book]')
  var scopePanel = document.querySelector('[data-scope]')
  var state = { services: [], intakeLive: false, chosen: null, mode: 'full', intent: null, stripe: null, elements: null, element: null, opened: 0 }

  /* ── the shelf ───────────────────────────────────────────────────────── */

  function money(row) {
    return row && row.display ? row.display : DASH
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  function render() {
    if (!listEl) return
    listEl.innerHTML = state.services
      .map(function (s) {
        // A tier-03 row whose Stripe price has not resolved shows the scope
        // door rather than a dead button. A configuration gap on our side
        // should cost us a click, never cost the visitor the journey.
        var priced = s.buyable && s.price
        var action = priced
          ? '<button class="btn btn-primary" type="button" data-choose="' + esc(s.id) + '">Book it</button>'
          : '<button class="btn btn-secondary" type="button" data-scope-for="' + esc(s.id) + '">Request the scope</button>'
        var figure = priced
          ? '<b>' + esc(money(s.price)) + '</b>' + (s.deposit ? '<span class="svc-dep">or ' + esc(money(s.deposit)) + ' today, the balance on delivery</span>' : '')
          : '<span class="svc-quote">Scoped in writing</span>'
        return (
          '<div class="svc-row" id="svc-' + esc(s.id) + '">' +
          '<div><h3>' + esc(s.name) + '</h3><p class="fine-13" style="margin:6px 0 0;color:var(--faint)">Tier ' + esc(s.tier) + ' · ' + esc(s.turnaround) + '</p></div>' +
          '<div><p class="body-14" style="margin:0;">' + esc(s.blurb) + '</p>' +
          '<ul class="svc-delivers">' + s.delivers.map(function (d) { return '<li>' + esc(d) + '</li>' }).join('') + '</ul></div>' +
          '<div class="svc-price">' + figure + '</div>' +
          '<div>' + action + '</div>' +
          '</div>'
        )
      })
      .join('')
  }

  function load() {
    fetch('/api/services', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .then(function (data) {
        state.services = (data && data.services) || []
        state.intakeLive = Boolean(data && data.intakeLive)
        render()
        fillScopeChoices()
        if (location.hash) jumpTo(location.hash.slice(1))
      })
      .catch(function () {
        if (listEl) {
          listEl.innerHTML =
            '<div class="svc-row"><p class="body-14" style="grid-column:1/-1;margin:0;">We could not load the shelf just now. ' +
            '<a href="/contact/?about=service">Write to us</a> and we will scope it by hand.</p></div>'
        }
      })
  }

  function jumpTo(id) {
    var s = state.services.filter(function (x) { return x.id === id })[0]
    if (!s) return
    if (s.buyable && s.price) choose(id)
    else openScope(id)
  }

  /* ── booking ─────────────────────────────────────────────────────────── */

  function choose(id) {
    var s = state.services.filter(function (x) { return x.id === id })[0]
    if (!s || !panel) return
    state.chosen = s
    state.mode = 'full'
    teardown()
    panel.hidden = false
    panel.querySelector('[data-book-name]').textContent = s.name
    panel.querySelector('[data-book-turnaround]').textContent = s.turnaround
    var modes = panel.querySelector('[data-book-modes]')
    modes.innerHTML =
      '<label class="check"><input type="radio" name="mode" value="full" checked /><span>Pay in full — <b>' + esc(money(s.price)) + '</b></span></label>' +
      (s.deposit
        ? '<label class="check"><input type="radio" name="mode" value="deposit" /><span>50% deposit — <b>' + esc(money(s.deposit)) + '</b> today, the balance on delivery</span></label>'
        : '')
    setStep(1)
    setError('')
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function setStep(n) {
    if (!panel) return
    panel.querySelectorAll('[data-book-step]').forEach(function (el) {
      el.hidden = Number(el.getAttribute('data-book-step')) !== n
    })
  }

  function setError(message, where) {
    var target = (where || panel)
    if (!target) return
    var el = target.querySelector('[data-book-error]')
    if (!el) return
    el.textContent = message || ''
    el.hidden = !message
  }

  function details() {
    return {
      name: value('[name="bname"]'),
      email: value('[name="bemail"]'),
      handle: value('[name="bhandle"]'),
      platform: value('[name="bplatform"]'),
      niche: value('[name="bniche"]'),
      notes: value('[name="bnotes"]'),
      agreed: Boolean(panel.querySelector('[name="bagreed"]') && panel.querySelector('[name="bagreed"]').checked),
    }
  }

  function value(sel) {
    var el = panel && panel.querySelector(sel)
    return el ? String(el.value || '').trim() : ''
  }

  function appearance() {
    // The same tokens the product checkout hands Stripe, read off the page so
    // the two payment fields are the same field in two places.
    var css = window.getComputedStyle(document.documentElement)
    var token = function (n, f) { return (css.getPropertyValue(n) || '').trim() || f }
    var seal = token('--seal', '#4E312C')
    var sage = token('--sage', '#567363')
    var border = token('--border', 'rgba(78, 49, 44, 0.14)')
    var faint = token('--faint', 'rgba(78, 49, 44, 0.40)')
    var label = { fontSize: '11px', fontWeight: '700', letterSpacing: '0.1em', textTransform: 'uppercase', color: faint }
    return {
      theme: 'flat',
      variables: {
        fontFamily: "'Raleway', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        fontSizeBase: '15px',
        colorPrimary: sage,
        colorBackground: token('--card', '#FFFFFF'),
        colorText: seal,
        colorTextSecondary: token('--muted', 'rgba(78,49,44,0.55)'),
        colorTextPlaceholder: faint,
        colorDanger: '#A8443C',
        borderRadius: '11px',
        spacingUnit: '4px',
        spacingGridRow: '18px',
      },
      rules: {
        '.Input': { border: '1.5px solid ' + border, boxShadow: 'none', padding: '13px 15px', fontWeight: '400' },
        '.Input:focus': { border: '1.5px solid ' + sage, boxShadow: 'none', outline: 'none' },
        '.Label': label,
        '.Label--floating': label,
        '.Tab': { border: '1.5px solid ' + border, boxShadow: 'none', padding: '13px 16px' },
        '.Tab--selected': { border: '1.5px solid ' + sage, backgroundColor: token('--sage-tint', 'rgba(86,115,99,0.10)'), color: seal },
        '.TabLabel': { fontWeight: '600' },
        '.Error': { fontSize: '13px' },
      },
    }
  }

  function teardown() {
    if (state.element) { try { state.element.unmount() } catch (e) { /* already gone */ } }
    state.element = null
    state.elements = null
    state.intent = null
  }

  function openPayment() {
    var d = details()
    if (!d.name) return setError('Add your name so we know who we are building for.')
    if (!/.+@.+\..+/.test(d.email)) return setError("That email doesn't look complete — it is where everything goes.")
    if (!d.agreed) return setError('Please accept the terms before we take payment.')
    if (!window.Stripe) return setError("The secure payment field could not load — an ad blocker or a strict network will do that. Write to us and we will send a link.")

    setError('')
    setStep(2)
    var mountPoint = panel.querySelector('[data-payment-element]')
    var stamp = ++state.opened
    teardown()
    mountPoint.innerHTML = ''
    panel.querySelector('[data-pay-state]').hidden = false

    fetch('/api/service-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: state.chosen.id,
        mode: state.mode,
        name: d.name,
        email: d.email,
        handle: d.handle,
        platform: d.platform,
        niche: d.niche,
        notes: d.notes,
        agreed: true,
      }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data } }) })
      .then(function (out) {
        // A stale response from a booking the visitor has already moved on
        // from must never mount over the current one.
        if (stamp !== state.opened) return
        if (!out.ok || !out.data.clientSecret) {
          panel.querySelector('[data-pay-state]').hidden = true
          if (out.data && out.data.scopeUrl) {
            setError(out.data.error || '')
            openScope(state.chosen.id)
            return
          }
          throw new Error((out.data && out.data.error) || 'We could not open the payment.')
        }
        state.intent = out.data
        state.stripe = window.Stripe(out.data.publishableKey)
        state.elements = state.stripe.elements({
          clientSecret: out.data.clientSecret,
          appearance: appearance(),
          fonts: [{ cssSrc: window.location.origin + '/assets/fonts/fonts.css' }],
        })
        state.element = state.elements.create('payment', {
          layout: { type: 'tabs', defaultCollapsed: false },
          fields: { billingDetails: { name: 'never', email: 'never' } },
        })
        state.element.on('ready', function () {
          panel.querySelector('[data-pay-state]').hidden = true
          var btn = panel.querySelector('[data-pay]')
          btn.disabled = false
          btn.textContent = 'Pay ' + out.data.display + ' securely'
        })
        state.element.on('loaderror', function (e) {
          panel.querySelector('[data-pay-state]').hidden = true
          setError((e && e.error && e.error.message) || "The payment field couldn't load. Nothing was charged.")
        })
        state.element.mount(mountPoint)
        panel.querySelector('[data-pay-total]').textContent = out.data.display
        panel.querySelector('[data-pay-ref]').textContent = out.data.reference
      })
      .catch(function (err) {
        if (stamp !== state.opened) return
        panel.querySelector('[data-pay-state]').hidden = true
        setError((err && err.message) || 'We could not open the payment — nothing was charged.')
      })
  }

  function pay() {
    if (!state.stripe || !state.elements || !state.intent) return
    var btn = panel.querySelector('[data-pay]')
    var d = details()
    setError('')
    btn.disabled = true
    btn.textContent = 'Confirming…'
    state.stripe
      .confirmPayment({
        elements: state.elements,
        confirmParams: {
          // The server's own return URL — a bare /shop/order/ that Stripe
          // appends the intent and its client secret to. Never derived here:
          // a path built in the browser is a path a browser can get wrong.
          return_url: state.intent.returnUrl,
          payment_method_data: { billing_details: { name: d.name, email: d.email } },
        },
      })
      .then(function (result) {
        if (!result || !result.error) return
        btn.disabled = false
        btn.textContent = 'Pay ' + state.intent.display + ' securely'
        setError(result.error.message || 'That payment did not go through. Nothing was charged.')
      })
  }

  /* ── the scope door ──────────────────────────────────────────────────── */

  function fillScopeChoices() {
    if (!scopePanel) return
    var select = scopePanel.querySelector('[name="sservice"]')
    if (!select) return
    var scoped = state.services.filter(function (s) { return !s.buyable || !s.price })
    select.innerHTML =
      '<option value="">Choose one</option>' +
      scoped.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + ' · ' + esc(s.turnaround) + '</option>' }).join('')
  }

  function openScope(id) {
    if (!scopePanel) return
    scopePanel.hidden = false
    var select = scopePanel.querySelector('[name="sservice"]')
    if (select && id) select.value = id
    // The minimum fill time starts when the form is actually revealed, not on
    // page load — otherwise a visitor who reads the page for four minutes and
    // then fills it in ten seconds sails past a guard meant to catch a bot.
    scopePanel.setAttribute('data-opened', String(Date.now()))
    scopePanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function submitScope() {
    var get = function (n) {
      var el = scopePanel.querySelector('[name="' + n + '"]')
      return el ? String(el.value || '').trim() : ''
    }
    var btn = scopePanel.querySelector('[data-scope-send]')
    var errEl = scopePanel.querySelector('[data-book-error]')
    var say = function (m) { if (errEl) { errEl.textContent = m || ''; errEl.hidden = !m } }

    say('')
    btn.disabled = true
    var was = btn.textContent
    btn.textContent = 'Sending…'

    fetch('/api/scope-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: get('sservice'),
        name: get('sname'),
        email: get('semail'),
        handle: get('shandle'),
        platform: get('splatform'),
        niche: get('sniche'),
        goal: get('sgoal'),
        timing: get('stiming'),
        budget: get('sbudget'),
        company_website: get('company_website'),
        elapsed: Date.now() - Number(scopePanel.getAttribute('data-opened') || Date.now()),
      }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data } }) })
      .then(function (out) {
        btn.disabled = false
        btn.textContent = was
        if (!out.ok || !out.data.ok) {
          if (out.data && out.data.buyable) {
            say(out.data.error)
            return
          }
          throw new Error((out.data && out.data.error) || 'That did not send.')
        }
        scopePanel.querySelector('[data-scope-form]').hidden = true
        var done = scopePanel.querySelector('[data-scope-done]')
        done.hidden = false
        done.querySelector('[data-scope-message]').textContent = out.data.message
        done.querySelector('[data-scope-ref]').textContent = out.data.reference
      })
      .catch(function (err) {
        btn.disabled = false
        btn.textContent = was
        say((err && err.message) || 'That did not send. Write to us and we will take it from here.')
      })
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-choose],[data-scope-for],[data-book-back],[data-book-pay],[data-pay],[data-scope-send],[data-book-close]') : null
    if (!el) return
    if (el.hasAttribute('data-choose')) return choose(el.getAttribute('data-choose'))
    if (el.hasAttribute('data-scope-for')) return openScope(el.getAttribute('data-scope-for'))
    if (el.hasAttribute('data-book-back')) { setStep(1); teardown(); return }
    if (el.hasAttribute('data-book-pay')) return openPayment()
    if (el.hasAttribute('data-pay')) return pay()
    if (el.hasAttribute('data-scope-send')) return submitScope()
    if (el.hasAttribute('data-book-close')) { teardown(); panel.hidden = true }
  })

  document.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'mode') {
      state.mode = e.target.value === 'deposit' ? 'deposit' : 'full'
      // The amount changes, so the intent that was opened for the old one is
      // no longer the right one. Re-opened on the way into step 2.
      teardown()
    }
  })

  load()
})()
