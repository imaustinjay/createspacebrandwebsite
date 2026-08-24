// The account — both sides of the door.
//
// On /shop/account/ this runs the create/login/reset forms against
// /api/account-auth. On /account/ it reads /api/account and draws the portal:
// purchases, membership, the Collection door, brand invoices.
//
// The session lives in an HttpOnly cookie this script cannot read — "am I
// signed in" is always a question to the server, never a guess from storage.
// Everything rendered here is built with textContent, never innerHTML from
// data: order references and invoice numbers pass through Stripe and Supabase
// on their way here, and a portal is the wrong place to trust a string.
;(function () {
  'use strict'

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  function api(path, body) {
    return fetch(path, body === undefined
      ? { headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    ).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        data.httpOk = res.ok
        data.httpStatus = res.status
        return data
      })
    })
  }

  // A small element builder, so every piece of data lands as text.
  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function day(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d)) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  }

  // ================================================================ the door
  var authForm = document.querySelector('[data-account="auth"]')
  if (authForm) door()

  function door() {
    var resetForm = document.querySelector('[data-account="reset"]')
    var confirmPanel = document.getElementById('account-confirm')
    var sentPanel = document.getElementById('account-sent')

    // A recovery link lands back here with its token in the fragment — the
    // fragment, deliberately, so the token never reaches any server log.
    var frag = new URLSearchParams((window.location.hash || '').replace(/^#/, ''))
    var recoveryToken = frag.get('type') === 'recovery' ? frag.get('access_token') : null
    if (recoveryToken && resetForm) {
      authForm.hidden = true
      resetForm.hidden = false
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', window.location.pathname)
      }
      wire(resetForm, function (fields) {
        return api('/api/account-auth', { action: 'reset', token: recoveryToken, password: fields.password }).then(function (data) {
          if (!data.ok) throw new Error(data.message || '')
          show(sentPanel, resetForm, { note: 'New password set — log in with it.' })
        })
      })
    } else {
      // Already in? Then this page is the wrong room.
      api('/api/account-auth').then(function (data) {
        if (data.in) window.location.replace('/account/')
      }).catch(function () {})
    }

    // The create/login tabs. shop.js still styles the selection; the mode —
    // which fields exist, what the button says — is decided here.
    var tabs = authForm.parentElement.querySelector('.tabs')
    function setMode(mode) {
      authForm.setAttribute('data-mode', mode)
      authForm.querySelectorAll('[data-create-only]').forEach(function (node) {
        node.hidden = mode !== 'create'
        node.querySelectorAll('input').forEach(function (i) { i.disabled = mode !== 'create' })
      })
      authForm.querySelectorAll('[data-login-only]').forEach(function (node) {
        node.hidden = mode !== 'login'
      })
      if (mode === 'create') syncBrand()
      var password = authForm.querySelector('[name="password"]')
      if (password) password.setAttribute('autocomplete', mode === 'create' ? 'new-password' : 'current-password')
      var cta = authForm.querySelector('[data-cta]')
      if (cta) cta.textContent = mode === 'create' ? 'Create my account' : 'Log in'
    }
    if (tabs) {
      tabs.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')) })
      })
    }

    // "I'm here as a brand" opens the company field; closed, the field
    // leaves the form entirely so it can't be validated or sent by mistake.
    var brandBox = authForm.querySelector('[name="brand"]')
    function syncBrand() {
      var on = Boolean(brandBox && brandBox.checked) && authForm.getAttribute('data-mode') === 'create'
      authForm.querySelectorAll('[data-brand-only]').forEach(function (node) {
        node.hidden = !on
        node.querySelectorAll('input').forEach(function (i) { i.disabled = !on })
      })
    }
    if (brandBox) brandBox.addEventListener('change', syncBrand)
    setMode('create')

    wire(authForm, function (fields) {
      var mode = authForm.getAttribute('data-mode')
      var body = mode === 'create'
        ? { action: 'signup', name: fields.name, email: fields.email, password: fields.password,
            kind: brandBox && brandBox.checked ? 'brand' : 'customer', company: fields.company || '' }
        : { action: 'login', email: fields.email, password: fields.password }
      return api('/api/account-auth', body).then(function (data) {
        if (!data.ok) throw new Error(data.message || '')
        if (data.state === 'in') {
          window.location.assign('/account/')
          return
        }
        // Created, unconfirmed — the next step is an inbox, and the panel
        // says whose.
        if (confirmPanel) {
          confirmPanel.querySelectorAll('[data-fill="email"]').forEach(function (n) { n.textContent = fields.email })
          show(confirmPanel, authForm)
        }
      })
    })

    var forgot = authForm.querySelector('[data-forgot]')
    if (forgot) {
      forgot.addEventListener('click', function (e) {
        e.preventDefault()
        var email = ((authForm.querySelector('[name="email"]') || {}).value || '').trim()
        if (!EMAIL_RE.test(email)) {
          fail(authForm, 'Put your email in first — that’s where the reset link goes.')
          return
        }
        api('/api/account-auth', { action: 'recover', email: email }).then(function (data) {
          if (!data.ok) {
            fail(authForm, data.message || 'That didn’t send — give it a moment and try again.')
            return
          }
          show(sentPanel, authForm, { note: data.message })
        }).catch(function () {
          fail(authForm, 'That didn’t send — our side, not yours. Give it a moment and try again.')
        })
      })
    }

    function show(panel, from, extra) {
      if (!panel) return
      from.hidden = true
      if (tabs && from === authForm) tabs.hidden = true
      if (extra && extra.note) {
        var note = panel.querySelector('[data-sent-note]')
        if (note) note.textContent = extra.note
      }
      panel.hidden = false
      panel.setAttribute('tabindex', '-1')
      panel.focus({ preventScroll: true })
    }
  }

  // The same house validation the other forms carry: data-msg on a field is
  // the sentence shown when that field is what's missing.
  function firstProblem(form) {
    var fields = form.querySelectorAll('input[data-msg]')
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

  function fail(form, message) {
    var line = form.querySelector('[data-error]')
    if (!line) return
    line.textContent = message
    line.hidden = false
  }

  function wire(form, submit) {
    var button = form.querySelector('button[type="submit"]')
    var label = button ? button.textContent : ''
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var line = form.querySelector('[data-error]')
      if (line) line.hidden = true

      // The honeypot: a filled hidden field is not a person.
      var hp = form.querySelector('input[name="website"]')
      if (hp && hp.value) return

      var problem = firstProblem(form)
      if (problem) {
        fail(form, problem.message)
        problem.field.focus()
        return
      }
      var fields = {}
      form.querySelectorAll('input').forEach(function (f) {
        if (f.name && !f.disabled && f.type !== 'checkbox') fields[f.name] = f.value.trim()
      })
      if (button) {
        button.disabled = true
        button.textContent = 'One moment…'
      }
      submit(fields).catch(function (err) {
        fail(form, err && err.message ? err.message : 'That didn’t go through — our side, not yours. Try again.')
      }).then(function () {
        if (button) {
          button.disabled = false
          button.textContent = label
        }
      })
    })
  }

  // ============================================================== the portal
  var portal = document.querySelector('[data-portal]')
  if (portal) room()

  function room() {
    var states = {}
    portal.querySelectorAll('[data-state]').forEach(function (node) {
      states[node.getAttribute('data-state')] = node
    })
    function state(name) {
      Object.keys(states).forEach(function (key) { states[key].hidden = key !== name })
    }

    portal.addEventListener('click', function (e) {
      if (e.target.closest('[data-signout]')) {
        api('/api/account-auth', { action: 'logout' }).then(function () {
          window.location.assign('/shop/account/')
        })
      }
    })

    api('/api/account').then(function (data) {
      if (!data.httpOk || !data.ok) {
        // Not signed in — the door is one page over.
        window.location.replace('/shop/account/')
        return
      }
      if (!data.confirmed) {
        fill(states.unconfirmed, data.user)
        state('unconfirmed')
        return
      }
      draw(data)
      state('in')
    }).catch(function () {
      window.location.replace('/shop/account/')
    })

    function fill(scope, user) {
      scope.querySelectorAll('[data-fill="email"]').forEach(function (n) { n.textContent = user.email })
      scope.querySelectorAll('[data-fill="firstName"]').forEach(function (n) {
        var first = String(user.name || '').trim().split(/\s+/)[0]
        n.textContent = first ? ', ' + first : ''
      })
      scope.querySelectorAll('[data-fill="company"]').forEach(function (n) {
        n.textContent = user.kind === 'brand' && user.company ? ' · ' + user.company : ''
      })
    }

    function draw(data) {
      var scope = states.in
      fill(scope, data.user)
      drawPurchases(scope, data.purchases || [])
      drawMembership(scope, data.membership, data.billable)
      drawInvoices(scope, data.invoices || [], data.user)
      liveCohort(scope)
    }

    function drawPurchases(scope, purchases) {
      var box = scope.querySelector('[data-purchases]')
      var empty = scope.querySelector('[data-empty="purchases"]')
      if (!purchases.length) {
        if (empty) empty.hidden = false
        return
      }
      purchases.forEach(function (order) {
        var card = el('div', 'acct-card')
        var head = el('div', 'acct-card-head')
        head.appendChild(el('b', null, order.reference ? 'Order ' + order.reference : 'Order'))
        var meta = [day(order.placedAt), order.total].filter(Boolean).join(' · ')
        head.appendChild(el('span', 'acct-meta', meta))
        card.appendChild(head)

        var list = el('ul', 'acct-lines')
        ;(order.items || []).forEach(function (item) {
          var li = el('li', null, item.name)
          if (!item.ready) li.appendChild(el('span', 'acct-meta', ' — files on their way'))
          list.appendChild(li)
        })
        card.appendChild(list)

        if (order.permalink) {
          var open = el('a', 'btn btn-secondary btn-sm', 'Downloads & receipt')
          open.href = order.permalink
          card.appendChild(open)
        }
        box.appendChild(card)
      })
    }

    function drawMembership(scope, membership, billable) {
      var box = scope.querySelector('[data-membership]')
      var empty = scope.querySelector('[data-empty="membership"]')
      var billing = scope.querySelector('[data-billing]')
      if (billing && billable) billing.hidden = false

      var manage = scope.querySelector('[data-manage-billing]')
      if (manage && billable) {
        manage.addEventListener('click', function () {
          manage.disabled = true
          api('/api/account-billing', {}).then(function (data) {
            manage.disabled = false
            if (data.ok && data.url) window.location.assign(data.url)
            else if (data.reason === 'portal-unconfigured') alertLine(scope, 'Billing management isn’t switched on yet — write to us and we’ll sort it by hand.')
            else alertLine(scope, 'That didn’t open — give it a moment and try again.')
          })
        })
      }

      if (!membership) {
        if (empty) empty.hidden = false
        return
      }
      var sentence = {
        trialing: 'On trial' + (membership.trialEndsAt ? ' — nothing is charged before ' + day(membership.trialEndsAt) : ''),
        active: 'Active' + (membership.renewsAt ? ' — renews ' + day(membership.renewsAt) : membership.endsAt ? ' — ends ' + day(membership.endsAt) : ''),
        past_due: 'Payment didn’t go through — update the card under Manage billing and nothing lapses',
        unpaid: 'Paused for non-payment — update the card under Manage billing',
        paused: 'Paused',
        canceled: 'Ended' + (membership.endsAt ? ' ' + day(membership.endsAt) : ''),
      }[membership.status] || membership.status

      var card = el('div', 'acct-card')
      var head = el('div', 'acct-card-head')
      var name = el('b')
      var em = el('em', 'emph', 'the craft')
      name.appendChild(em)
      name.appendChild(document.createTextNode(' — membership'))
      head.appendChild(name)
      head.appendChild(el('span', 'acct-meta', sentence))
      card.appendChild(head)
      box.appendChild(card)
    }

    function drawInvoices(scope, invoices, user) {
      var section = scope.querySelector('[data-section="invoices"]')
      if (!section) return
      // The section exists for brands, and for anyone an invoice has ever
      // actually been raised to — an empty pane helps neither.
      if (user.kind !== 'brand' && !invoices.length) return
      section.hidden = false

      var box = section.querySelector('[data-invoices]')
      var empty = section.querySelector('[data-empty="invoices"]')
      if (!invoices.length) {
        if (empty) empty.hidden = false
        return
      }
      invoices.forEach(function (inv) {
        var card = el('div', 'acct-card')
        var head = el('div', 'acct-card-head')
        head.appendChild(el('b', null, inv.number))
        var said = { open: 'Awaiting payment', paid: 'Paid', uncollectible: 'Written off' }[inv.status] || inv.status
        var meta = [day(inv.issuedAt), inv.total, said].filter(Boolean).join(' · ')
        head.appendChild(el('span', 'acct-meta', meta))
        card.appendChild(head)
        if (inv.dueAt && inv.status === 'open') {
          card.appendChild(el('p', 'acct-meta', 'Due ' + day(inv.dueAt)))
        }
        var row = el('p', 'acct-actions')
        if (inv.href) {
          var pay = el('a', inv.status === 'open' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm', inv.status === 'open' ? 'Pay this invoice' : 'View')
          pay.href = inv.href
          pay.rel = 'noopener'
          row.appendChild(pay)
        }
        if (inv.pdf) {
          var pdf = el('a', 'btn btn-ghost btn-sm', 'PDF')
          pdf.href = inv.pdf
          pdf.rel = 'noopener'
          row.appendChild(pdf)
        }
        if (row.childNodes.length) card.appendChild(row)
        box.appendChild(card)
      })
    }

    function alertLine(scope, message) {
      var section = scope.querySelector('[data-section="membership"]')
      var line = section.querySelector('.form-error') || section.appendChild(el('p', 'form-error'))
      line.textContent = message
      line.hidden = false
    }

    // The Collection note goes live when the workspace answers — and stays on
    // its honest default when it doesn't. Unknown is never shown as closed.
    function liveCohort(scope) {
      var note = scope.querySelector('[data-cohort-note]')
      if (!note) return
      fetch('/api/cohort-status', { headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null })
        .then(function (data) {
          if (!data || !data.ok || !data.state) return
          if (data.state === 'open') {
            note.textContent = 'Applications are open right now. The application, the seat and the eight weeks live in the workspace.'
          } else if (data.state === 'in-session') {
            note.textContent = 'A cohort is in session. If you hold a seat, everything — Pathway, Studio, Sessions, My Cohort — is in your workspace portal.'
          }
        })
        .catch(function () {})
    }
  }
})()
