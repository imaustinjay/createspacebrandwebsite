// Brand enquiry form — posts to the serverless handler and swaps to the
// confirmation state. The partnerships address lives server-side only; this
// file must never contain it.
(function () {
  var form = document.getElementById('enquiry-form');
  if (!form) return;

  var fields = document.getElementById('enquiry-fields');
  var received = document.getElementById('enquiry-received');
  var errorLine = document.getElementById('enquiry-error');
  var button = form.querySelector('button[type="submit"]');
  var openedAt = Date.now();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;

    errorLine.hidden = true;
    button.disabled = true;
    button.textContent = 'Sending…';

    var data = new FormData(form);
    var payload = {
      name: (data.get('name') || '').toString().trim(),
      email: (data.get('email') || '').toString().trim(),
      company: (data.get('company') || '').toString().trim(),
      budget: (data.get('budget') || '').toString(),
      timing: (data.get('timing') || '').toString().trim(),
      source: (data.get('source') || '').toString(),
      website: (data.get('website') || '').toString(), // honeypot
      elapsedMs: Date.now() - openedAt,
    };

    fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || 'send-failed');
          fields.style.display = 'none';
          received.hidden = false;
          received.style.display = 'grid';
          received.setAttribute('tabindex', '-1');
          received.focus({ preventScroll: true });
        });
      })
      .catch(function (err) {
        errorLine.textContent =
          err && err.message && err.message !== 'send-failed'
            ? err.message
            : "That didn't send — our side, not yours. Give it a moment and try again.";
        errorLine.hidden = false;
        button.disabled = false;
        button.textContent = 'Send enquiry';
      });
  });
})();
