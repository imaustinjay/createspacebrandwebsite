// The stockroom's behaviour: unlock, list what's in stock, put files in.
//
// Loaded only by /shop/admin/, which is noindex and linked from nowhere. The
// key is typed each session and kept in sessionStorage, so closing the tab
// closes the stockroom — it is never written to localStorage and never sent
// anywhere but /api/products, over the same TLS as everything else.
(function () {
  'use strict'

  var room = document.querySelector('[data-stockroom]')
  if (!room) return

  var KEY = 'cs.admin'
  var gate = room.querySelector('[data-gate]')
  var stock = room.querySelector('[data-room]')
  var list = room.querySelector('[data-products]')
  var tokenInput = room.querySelector('[name="token"]')
  var gateError = gate.querySelector('[data-error]')
  var token = ''

  function remember(value) {
    token = value
    try {
      if (value) window.sessionStorage.setItem(KEY, value)
      else window.sessionStorage.removeItem(KEY)
    } catch (e) {
      /* the key still works for this page, it just won't survive a reload */
    }
  }

  function fail(message) {
    gateError.textContent = message
    gateError.hidden = false
  }

  function api(path, options) {
    var opts = options || {}
    opts.headers = opts.headers || {}
    opts.headers.Authorization = 'Bearer ' + token
    return fetch('/api/products' + (path || ''), opts).then(function (res) {
      return res
        .json()
        .catch(function () { return {} })
        .then(function (data) {
          if (!res.ok) throw new Error(data.error || 'That didn’t work.')
          return data
        })
    })
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // ------------------------------------------------------------- the wiring
  // Setting the shop up means pasting values into a dashboard this page can't
  // see. Rather than find out whether they took by risking a purchase, ask.
  function renderWiring(config) {
    var panel = room.querySelector('[data-wiring]')
    if (!panel || !config) return
    panel.innerHTML = ''

    var rows = [
      ['Stripe secret key', config.secretKey, config.mode ? config.mode === 'live' ? 'Live mode — real money' : 'Test mode' : 'Set STRIPE_SECRET_KEY in Netlify'],
      ['Stripe publishable key', config.publishableKey, config.publishableKey ? 'The payment field can render' : 'Set STRIPE_PUBLISHABLE_KEY — without it the checkout stays shut'],
      [
        'Prices',
        config.priced === config.of,
        config.priced < 0
          ? "Couldn't reach Stripe to ask"
          : config.priced === config.of
            ? 'All ' + config.of + ' products priced'
            : config.priced + ' of ' + config.of + ' priced — the rest show no price and can’t be bought',
      ],
      [
        'Webhook',
        config.webhookSecret,
        config.webhookSecret
          ? config.webhookSecrets > 1
            ? config.webhookSecrets + ' signing secrets held — test and live can both deliver'
            : 'Payments will be delivered'
          : 'Set STRIPE_WEBHOOK_SECRET — without it nothing is emailed, ever',
      ],
      ['Mailbox', config.mail, config.mail ? 'Receipts and files can be sent' : 'Set MAIL_USER and MAIL_PASSWORD — no files can be delivered'],
    ]

    var ready = rows.every(function (r) { return r[1] })
    var head = el('div')
    head.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline; gap: 20px; flex-wrap: wrap; margin-bottom: 16px;'
    head.appendChild(el('span', 'shop-eyebrow', 'The wiring'))
    var verdict = el('span', 'shop-eyebrow', ready ? 'Ready to sell' : 'Not ready yet')
    verdict.style.color = ready ? 'var(--sage)' : 'var(--dusk)'
    head.appendChild(verdict)
    panel.appendChild(head)

    rows.forEach(function (row) {
      var line = el('div')
      line.style.cssText = 'display: grid; grid-template-columns: 14px 1fr; gap: 12px; align-items: start; padding: 9px 0; border-top: 1px solid var(--hairline);'
      var mark = el('span')
      mark.setAttribute('aria-hidden', 'true')
      mark.style.cssText =
        'width: 9px; height: 9px; margin-top: 6px; border-radius: 999px; background: ' +
        (row[1] ? 'var(--sage)' : 'var(--dusk)')
      line.appendChild(mark)
      var text = el('div')
      var name = el('b', null, row[0])
      name.style.cssText = 'display: block; font-size: 14.5px; font-weight: 500;'
      var note = el('span', 'fine-12', row[2])
      note.style.cssText = 'display: block; margin-top: 2px;'
      // Screen readers get the state as a word, not as a coloured dot.
      var state = el('span', null, row[1] ? 'Connected. ' : 'Missing. ')
      state.style.cssText = 'position: absolute; left: -9999px;'
      text.appendChild(state)
      text.appendChild(name)
      text.appendChild(note)
      line.appendChild(text)
      panel.appendChild(line)
    })
  }

  // Saving reloads the shelf, which rebuilds these cards — so the "Saved."
  // that was just written would vanish in the same tick. The message is
  // carried through the reload instead and printed by whichever card it
  // belongs to.
  function render(products, flash) {
    list.innerHTML = ''
    products.forEach(function (product) {
      var card = el('div', 'card')
      card.style.cssText = '--pad: 24px 26px; margin-bottom: 18px;'

      var head = el('div')
      head.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline; gap: 20px; flex-wrap: wrap;'
      var title = el('p', 't-24')
      title.style.margin = '0'
      title.textContent = product.name
      head.appendChild(title)
      var state = el('span', 'shop-eyebrow', product.ready ? 'In stock' : 'Nothing uploaded')
      state.setAttribute('data-stock-state', '')
      state.style.color = product.ready ? 'var(--sage)' : 'var(--faint)'
      head.appendChild(state)
      card.appendChild(head)

      var flashLine = el('p', 'fine-12')
      flashLine.setAttribute('data-flash', '')
      flashLine.style.cssText = 'margin: 10px 0 0; color: var(--sage);'
      flashLine.hidden = !(flash && flash.item === product.id)
      if (!flashLine.hidden) flashLine.textContent = flash.message
      card.appendChild(flashLine)

      var note = el('p', 'body-14', product.delivery)
      note.style.cssText = 'margin: 6px 0 18px; color: var(--muted);'
      card.appendChild(note)

      // ---------------------------------------------------------- files
      product.files.forEach(function (file) {
        var row = el('div', 'file-row')
        row.style.padding = '14px 0'
        var left = el('div')
        left.appendChild(el('b', null, file.label || file.name))
        left.appendChild(el('i', null, file.name + (file.readable ? ' · ' + file.readable : '')))
        row.appendChild(left)
        var actions = el('div', 'file-actions')
        var remove = el('button', 'btn btn-secondary', 'Remove')
        remove.type = 'button'
        remove.addEventListener('click', function () {
          remove.disabled = true
          remove.textContent = 'Removing…'
          api('?item=' + encodeURIComponent(product.id) + '&name=' + encodeURIComponent(file.name), { method: 'DELETE' })
            .then(function () { load({ item: product.id, message: 'Removed ' + file.name + '.' }) })
            .catch(function (err) {
              remove.disabled = false
              remove.textContent = 'Remove'
              window.alert(err.message)
            })
        })
        actions.appendChild(remove)
        row.appendChild(actions)
        card.appendChild(row)
      })

      // --------------------------------------------------------- upload
      var picker = el('div')
      picker.style.cssText = 'display: flex; gap: 11px; flex-wrap: wrap; align-items: center; margin-top: 16px; padding-top: 18px; border-top: 1px solid var(--hairline);'
      var input = document.createElement('input')
      input.type = 'file'
      input.style.cssText = 'font: inherit; font-size: 13px; max-width: 100%;'
      var progress = el('span', 'fine-12')
      progress.style.margin = '0'
      var upload = el('button', 'btn btn-primary', 'Upload')
      upload.type = 'button'
      upload.addEventListener('click', function () {
        var file = input.files && input.files[0]
        if (!file) {
          progress.textContent = 'Choose a file first.'
          return
        }
        upload.disabled = true
        progress.textContent = 'Uploading ' + file.name + '…'
        // The body is the file itself — no multipart, no parser, no
        // dependency. The name and label ride on the query string.
        api(
          '?item=' + encodeURIComponent(product.id) +
            '&name=' + encodeURIComponent(file.name) +
            '&label=' + encodeURIComponent(file.name.replace(/\.[a-z0-9]+$/i, '')),
          {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          }
        )
          .then(function () {
            load({ item: product.id, message: 'Uploaded ' + file.name + '.' })
          })
          .catch(function (err) {
            upload.disabled = false
            progress.textContent = err.message
          })
      })
      picker.appendChild(input)
      picker.appendChild(upload)
      picker.appendChild(progress)
      card.appendChild(picker)

      // ---------------------------------------------------------- links
      var linkWrap = el('div')
      linkWrap.style.cssText = 'margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--hairline);'
      linkWrap.appendChild(el('span', 'shop-eyebrow', 'Or deliver by link — one per line, as “Label | https://…”'))
      var area = document.createElement('textarea')
      area.rows = Math.max(2, product.links.length + 1)
      area.style.cssText = 'width: 100%; margin-top: 10px; font: inherit; font-size: 13.5px; padding: 12px 14px; border: 1.5px solid var(--border); border-radius: 11px; background: var(--card); color: var(--seal); resize: vertical;'
      area.value = product.links.map(function (l) { return l.label + ' | ' + l.url }).join('\n')
      area.placeholder = 'The preset pack (1.2 GB) | https://…'
      var saveRow = el('div')
      saveRow.style.cssText = 'display: flex; gap: 11px; align-items: center; margin-top: 11px;'
      var save = el('button', 'btn btn-secondary', 'Save links')
      save.type = 'button'
      var saved = el('span', 'fine-12')
      saved.style.margin = '0'
      save.addEventListener('click', function () {
        var links = area.value
          .split('\n')
          .map(function (line) { return line.trim() })
          .filter(Boolean)
          .map(function (line) {
            var at = line.lastIndexOf('|')
            return at < 0
              ? { label: 'Download', url: line.trim() }
              : { label: line.slice(0, at).trim() || 'Download', url: line.slice(at + 1).trim() }
          })
        save.disabled = true
        saved.textContent = 'Saving…'
        api('?item=' + encodeURIComponent(product.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ links: links }),
        })
          .then(function (data) {
            save.disabled = false
            var kept = (data.shelf && data.shelf.links && data.shelf.links.length) || 0
            load({
              item: product.id,
              message:
                kept === links.length
                  ? 'Saved ' + kept + (kept === 1 ? ' link.' : ' links.')
                  : 'Saved ' + kept + ' of ' + links.length + ' — the rest weren’t https:// links.',
            })
          })
          .catch(function (err) {
            save.disabled = false
            saved.textContent = err.message
          })
      })
      saveRow.appendChild(save)
      saveRow.appendChild(saved)
      linkWrap.appendChild(area)
      linkWrap.appendChild(saveRow)
      card.appendChild(linkWrap)

      list.appendChild(card)
    })
  }

  function load(flash) {
    return api('', { method: 'GET' })
      .then(function (data) {
        gate.hidden = true
        stock.hidden = false
        renderWiring(data.config)
        render(data.products || [], flash)
      })
      .catch(function (err) {
        remember('')
        gate.hidden = false
        stock.hidden = true
        fail(err.message === 'Not authorised.' ? 'That key was refused. Check ADMIN_TOKEN in Netlify.' : err.message)
      })
  }

  room.querySelector('[data-unlock]').addEventListener('click', function () {
    gateError.hidden = true
    var value = (tokenInput.value || '').trim()
    if (!value) return fail('Paste the key first.')
    remember(value)
    load()
  })

  tokenInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') room.querySelector('[data-unlock]').click()
  })

  // Already unlocked this tab? Go straight in.
  try {
    var held = window.sessionStorage.getItem(KEY)
    if (held) {
      token = held
      load()
    }
  } catch (e) {
    /* nothing held — the gate is the default state anyway */
  }
})()
