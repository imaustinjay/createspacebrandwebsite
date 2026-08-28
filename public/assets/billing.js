// The billing desk — the Billing tab of /admin/.
//
// Issue an invoice to a brand with nothing but a name and an email, read the
// ledger back, resend the branded email, void a mistake. Everything talks to
// /api/billing, which sits behind the same session cookie the rest of the
// portal already holds — this file never handles a credential of its own.
//
// Like the rest of the portal: no innerHTML from data, everything built with
// textContent, because invoice numbers and names round-trip through Stripe
// and a ledger is the wrong place to trust a string.
;(function () {
  'use strict'

  var panel = document.querySelector('[data-panel="billing"]')
  var tab = document.querySelector('[data-tab="billing"]')
  if (!panel || !tab) return

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  var booted = false

  tab.addEventListener('click', function () {
    if (booted) return
    booted = true
    build()
    readLedger()
  })

  function api(path, body) {
    var opts = { credentials: 'same-origin', headers: {} }
    if (body !== undefined) {
      opts.method = 'POST'
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'That did not work.')
        return data
      })
    })
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function day(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  }

  var form, linesBox, errorLine, okLine, ledgerBox, statLine

  // ------------------------------------------------------------- the desk
  function build() {
    var wrap = el('div', 'p-block')
    var head = el('div', 'p-head')
    head.appendChild(el('h2', null, 'Issue an invoice'))
    head.appendChild(el('span', 'p-note', 'A name and an email is all it takes — no account needed on their side.'))
    wrap.appendChild(head)

    form = el('form', 'bill-form')
    form.noValidate = true

    var two = el('div', 'form-two')
    two.appendChild(field('Contact name', 'name', 'Their name', 'text'))
    two.appendChild(field('Brand / company (optional)', 'company', 'The name on the invoice', 'text'))
    form.appendChild(two)
    form.appendChild(field('Email', 'email', 'billing@brand.com', 'email'))

    var linesLabel = el('div', 'bill-lines-label', 'What the invoice is for')
    form.appendChild(linesLabel)
    linesBox = el('div', 'bill-lines')
    form.appendChild(linesBox)
    addLine()

    var addBtn = el('button', 'portal-ghost', '+ Add a line')
    addBtn.type = 'button'
    addBtn.addEventListener('click', addLine)
    form.appendChild(addBtn)

    form.appendChild(field('Note on the invoice (optional)', 'memo', 'e.g. October campaign — deliverables as scoped', 'text'))

    var dueWrap = el('label', 'field')
    dueWrap.appendChild(el('span', null, 'Due'))
    var due = el('select')
    due.name = 'daysUntilDue'
    ;[['7', 'In 7 days'], ['14', 'In 14 days'], ['30', 'In 30 days'], ['60', 'In 60 days']].forEach(function (opt) {
      var o = el('option', null, opt[1])
      o.value = opt[0]
      if (opt[0] === '14') o.selected = true
      due.appendChild(o)
    })
    dueWrap.appendChild(due)
    form.appendChild(dueWrap)

    errorLine = el('p', 'form-error')
    errorLine.hidden = true
    form.appendChild(errorLine)
    okLine = el('p', 'bill-ok')
    okLine.hidden = true
    form.appendChild(okLine)

    var submit = el('button', 'btn btn-primary', 'Issue & email the invoice')
    submit.type = 'submit'
    form.appendChild(submit)
    form.appendChild(el('p', 'bill-fine', 'The brand gets the house’s own email — wordmark, the lines, one pay button. The payment happens on Stripe’s secured page and lands in the same balance as the shop. Card, Klarna and Afterpay are offered on the invoice, so a brand can split a four-figure engagement without a separate arrangement.'))

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      issue(submit)
    })

    wrap.appendChild(form)
    panel.appendChild(wrap)

    var ledgerWrap = el('div', 'p-block')
    var lh = el('div', 'p-head')
    lh.appendChild(el('h2', null, 'The ledger'))
    statLine = el('span', 'p-note', 'Reading…')
    lh.appendChild(statLine)
    ledgerWrap.appendChild(lh)
    ledgerBox = el('div')
    ledgerWrap.appendChild(ledgerBox)
    panel.appendChild(ledgerWrap)
  }

  function field(label, name, placeholder, type) {
    var wrap = el('label', 'field')
    wrap.appendChild(el('span', null, label))
    var input = el('input')
    input.type = type
    input.name = name
    input.placeholder = placeholder
    wrap.appendChild(input)
    return wrap
  }

  function addLine() {
    var row = el('div', 'bill-line')
    var desc = el('input')
    desc.type = 'text'
    desc.placeholder = 'Description — e.g. Creator campaign, October'
    desc.setAttribute('data-desc', '')
    var amount = el('input')
    amount.type = 'text'
    amount.inputMode = 'decimal'
    amount.placeholder = '$ amount'
    amount.setAttribute('data-amount', '')
    row.appendChild(desc)
    row.appendChild(amount)
    if (linesBox.children.length) {
      var drop = el('button', 'bill-drop', '×')
      drop.type = 'button'
      drop.title = 'Remove this line'
      drop.addEventListener('click', function () { row.remove() })
      row.appendChild(drop)
    }
    linesBox.appendChild(row)
  }

  function value(name) {
    var input = form.querySelector('[name="' + name + '"]')
    return input ? input.value.trim() : ''
  }

  function fail(message) {
    okLine.hidden = true
    errorLine.textContent = message
    errorLine.hidden = false
  }

  function issue(submit) {
    errorLine.hidden = true
    okLine.hidden = true

    var lines = [].slice.call(linesBox.querySelectorAll('.bill-line')).map(function (row) {
      return {
        description: row.querySelector('[data-desc]').value.trim(),
        amount: row.querySelector('[data-amount]').value.trim(),
      }
    }).filter(function (l) { return l.description || l.amount })

    if (!value('name')) return fail('Add the contact name.')
    if (!EMAIL_RE.test(value('email'))) return fail('That email doesn’t look right.')
    if (!lines.length) return fail('An invoice needs at least one line.')

    submit.disabled = true
    var label = submit.textContent
    submit.textContent = 'Issuing…'

    api('/api/billing', {
      action: 'issue',
      name: value('name'),
      company: value('company'),
      email: value('email'),
      memo: value('memo'),
      daysUntilDue: Number(value('daysUntilDue')) || 14,
      lines: lines,
    }).then(function (data) {
      // Say whether the plan methods actually made it onto this invoice.
      // Stripe turns them down above their own ceilings and when the account
      // hasn't activated them, and a four-figure engagement issued card-only
      // is worth knowing about before the brand finds out instead.
      var plans = data.plans
        ? ' Klarna and Afterpay are on it.'
        : ' Card only on this one — Stripe wouldn’t take the plan methods, so check they’re active and inside their limits if the brand asked to split it.'
      okLine.textContent = (data.mailed
        ? 'Issued and emailed — ' + data.invoice.number + ', ' + data.invoice.total + '.'
        : 'Issued (' + data.invoice.number + ') — but the mailbox isn’t connected, so nothing was emailed. Open it below and send them the link yourself.') + plans
      okLine.hidden = false
      form.reset()
      while (linesBox.firstChild) linesBox.removeChild(linesBox.firstChild)
      addLine()
      readLedger()
    }).catch(function (err) {
      fail(err.message || 'That didn’t go through — try again.')
    }).then(function () {
      submit.disabled = false
      submit.textContent = label
    })
  }

  // ------------------------------------------------------------ the ledger
  function readLedger() {
    api('/api/billing').then(function (data) {
      statLine.textContent = data.openCount
        ? data.openCount + ' awaiting payment · ' + data.outstanding + ' outstanding'
        : 'Nothing outstanding.'
      while (ledgerBox.firstChild) ledgerBox.removeChild(ledgerBox.firstChild)
      if (!data.invoices.length) {
        ledgerBox.appendChild(el('p', 'bill-fine', 'No invoices yet. The first one you issue appears here, alongside whether it has been paid.'))
        return
      }
      data.invoices.forEach(function (inv) { ledgerBox.appendChild(card(inv)) })
    }).catch(function (err) {
      statLine.textContent = err.message || 'Could not read the ledger.'
    })
  }

  function card(inv) {
    var box = el('div', 'bill-card')
    box.dataset.status = inv.status
    var head = el('div', 'bill-card-head')
    head.appendChild(el('b', null, inv.number))
    var said = { open: 'Awaiting payment', paid: 'Paid', void: 'Voided', uncollectible: 'Written off', draft: 'Draft' }[inv.status] || inv.status
    head.appendChild(el('span', 'bill-meta', [inv.total, said].filter(Boolean).join(' · ')))
    box.appendChild(head)

    var whoLine = [inv.name, inv.email].filter(Boolean).join(' · ')
    if (whoLine) box.appendChild(el('p', 'bill-meta', whoLine))
    var whenLine = [
      inv.issuedAt ? 'Issued ' + day(inv.issuedAt) : '',
      inv.status === 'open' && inv.dueAt ? 'due ' + day(inv.dueAt) : '',
      inv.status === 'paid' && inv.paidAt ? 'paid ' + day(inv.paidAt) : '',
    ].filter(Boolean).join(' · ')
    if (whenLine) box.appendChild(el('p', 'bill-meta', whenLine))

    var row = el('p', 'bill-actions')
    if (inv.href) row.appendChild(link(inv.href, 'Open'))
    if (inv.pdf) row.appendChild(link(inv.pdf, 'PDF'))
    if (inv.status === 'open') {
      row.appendChild(action('Resend email', function (btn) {
        btn.disabled = true
        api('/api/billing', { action: 'resend', id: inv.id }).then(function () {
          btn.textContent = 'Sent again'
        }).catch(function (err) {
          btn.disabled = false
          btn.textContent = err.message || 'Resend email'
        })
      }))
      row.appendChild(action('Void', function (btn) {
        if (!window.confirm('Void ' + inv.number + '? It can never be paid after this.')) return
        btn.disabled = true
        api('/api/billing', { action: 'void', id: inv.id }).then(readLedger).catch(function (err) {
          btn.disabled = false
          btn.textContent = err.message || 'Void'
        })
      }))
    }
    box.appendChild(row)
    return box
  }

  function link(href, label) {
    var a = el('a', 'portal-ghost', label)
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    return a
  }

  function action(label, onClick) {
    var btn = el('button', 'portal-ghost', label)
    btn.type = 'button'
    btn.addEventListener('click', function () { onClick(btn) })
    return btn
  }
})()
