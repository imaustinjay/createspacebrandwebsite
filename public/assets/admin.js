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

  // "0 of 6 priced" names the symptom. This names the cause, because the two
  // possible ones need opposite fixes: an empty account needs products made,
  // and an account full of unlabelled prices needs lookup keys set. Telling
  // them apart from the outside is impossible, so ask Stripe and show it.
  function priceHelp(config) {
    var wrap = el('div')
    wrap.style.cssText = 'margin: 12px 0 4px; padding: 14px 16px; background: var(--dusk-tint); border-radius: 11px;'
    var say = function (text, bold) {
      var p = el('p', 'fine-12', text)
      p.style.cssText = 'margin: 0 0 8px;' + (bold ? ' font-weight: 700;' : '')
      wrap.appendChild(p)
      return p
    }

    if (!config.found) {
      say('Stripe couldn’t be asked what prices it holds — check the function log.')
      return wrap
    }

    // Anything already carrying a shelf lookup key is working; what's
    // interesting is the rest.
    var loose = config.found.filter(function (p) { return !p.claimed })

    if (!config.found.length) {
      say('Your live Stripe account has no active prices at all.', true)
      say(
        'Products made in sandbox do not exist in live mode — they have to be created again here. ' +
          'Make six products, one price each, and give each price a lookup key from this list:'
      )
      var ids = el('p', 'fine-12', config.wanted.join(' · '))
      ids.style.cssText = 'margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;'
      wrap.appendChild(ids)
      return wrap
    }

    say(
      loose.length + (loose.length === 1 ? ' price exists' : ' prices exist') +
        ' in your Stripe account that this shelf can’t claim:',
      true
    )

    var table = el('div')
    table.style.cssText = 'display: grid; gap: 7px; margin: 10px 0 12px;'
    loose.forEach(function (price) {
      var row = el('div')
      row.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; font-size: 12px;'
      var label = el('b', null, price.name)
      label.style.cssText = 'font-weight: 600;'
      row.appendChild(label)
      if (price.amount !== null) {
        row.appendChild(el('span', null, money(price.amount, price.currency) + (price.recurring ? ' / recurring' : '')))
      }
      var id = el('code', null, price.id)
      id.style.cssText = 'font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted);'
      row.appendChild(id)
      row.appendChild(el('span', null, price.lookupKey ? 'lookup key: ' + price.lookupKey : 'no lookup key'))
      table.appendChild(row)
    })
    wrap.appendChild(table)

    say(
      'Either set each price’s lookup key to one of ' + config.wanted.join(', ') +
        ' — or paste the price ids into Netlify as STRIPE_PRICE_START_SMALL, STRIPE_PRICE_AESTHETIC_KIT, ' +
        'STRIPE_PRICE_CREATOR_PLANNER, STRIPE_PRICE_CONTENT_SYSTEM, STRIPE_PRICE_STARTER_BUNDLE, ' +
        'STRIPE_PRICE_THE_CRAFT, and redeploy.'
    )
    return wrap
  }

  // House money formatting, so a diagnosed price reads the way a shelf price
  // does. Mirrors the server's, minus the currencies this panel won't meet.
  var ZERO_DECIMAL = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']
  function money(amount, currency) {
    var code = String(currency || 'usd').toLowerCase()
    var value = ZERO_DECIMAL.indexOf(code) >= 0 ? amount : amount / 100
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code.toUpperCase(),
        minimumFractionDigits: value % 1 === 0 ? 0 : 2,
      }).format(value)
    } catch (e) {
      return value + ' ' + code.toUpperCase()
    }
  }

  // ------------------------------------------------------------- the wiring
  // Setting the shop up means pasting values into a dashboard this page can't
  // see. Rather than find out whether they took by risking a purchase, ask.
  function renderWiring(config) {
    var panel = room.querySelector('[data-wiring]')
    if (!panel || !config) return
    panel.innerHTML = ''

    var rows = [
      ['Stripe secret key', config.secretKey, config.mode ? config.mode === 'live' ? 'Live mode — real money' : 'Test mode — no real money moves' : 'Set STRIPE_SECRET_KEY in Netlify'],
      [
        'Stripe publishable key',
        config.publishableKey && !config.keyMismatch,
        config.keyMismatch
          ? 'A ' + config.publishableMode + '-mode key beside a ' + config.mode + '-mode secret — they must match, and checkout is refusing to open until they do'
          : config.publishableKey
            ? 'The payment field can render'
            : 'Set STRIPE_PUBLISHABLE_KEY — without it the checkout stays shut',
      ],
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
      // The diagnosis belongs under the row it explains, not above its label.
      if (row[0] === 'Prices' && !row[1]) text.appendChild(priceHelp(config))
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

  // ---------------------------------------------------------- a new key
  // 32 bytes from the browser's CSPRNG, in an alphabet that survives being
  // pasted into a dashboard, read off a screen, and typed back in: no
  // punctuation to be eaten by a shell, and no 0/O/1/l to be misread.
  //
  // Never sent anywhere. There is nowhere to send it — this runs entirely in
  // the tab, and the value only becomes real once it's in Netlify.
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

  function makeKey(length) {
    var bytes = new Uint8Array(length)
    window.crypto.getRandomValues(bytes)
    var out = ''
    // Reject above the largest whole multiple of the alphabet rather than
    // taking a modulo of everything, which would quietly favour the first
    // few letters. Redraw instead of biasing.
    var limit = 256 - (256 % ALPHABET.length)
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] >= limit) {
        var extra = new Uint8Array(1)
        do { window.crypto.getRandomValues(extra) } while (extra[0] >= limit)
        bytes[i] = extra[0]
      }
      out += ALPHABET[bytes[i] % ALPHABET.length]
    }
    return out
  }

  var maker = room.querySelector('[data-make-key]')
  if (maker && window.crypto && window.crypto.getRandomValues) {
    var newKeyBox = room.querySelector('[data-new-key]')
    var newKeyValue = room.querySelector('[data-key-value]')
    var copyBtn = room.querySelector('[data-copy-key]')

    maker.addEventListener('click', function () {
      newKeyValue.value = makeKey(40)
      newKeyBox.hidden = false
      newKeyValue.focus()
      newKeyValue.select()
    })

    copyBtn.addEventListener('click', function () {
      newKeyValue.select()
      var done = function () {
        copyBtn.textContent = 'Copied'
        window.setTimeout(function () { copyBtn.textContent = 'Copy' }, 2000)
      }
      if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
        window.navigator.clipboard.writeText(newKeyValue.value).then(done, function () {
          // Clipboard permission refused — it's selected, so ⌘C still works.
          copyBtn.textContent = 'Press ⌘C'
        })
      } else {
        copyBtn.textContent = 'Press ⌘C'
      }
    })
  } else if (maker) {
    maker.hidden = true
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
