// Client service inquiry — posts to the serverless handler and swaps to the
// confirmation state. The destination mailbox lives server-side only; this
// file must never contain it.
(function () {
  var form = document.getElementById('inquiry-form');
  if (!form) return;

  var fields = document.getElementById('inquiry-fields');
  var received = document.getElementById('inquiry-received');
  var errorLine = document.getElementById('inquiry-error');
  var servicesError = document.getElementById('services-error');
  var button = form.querySelector('button[type="submit"]');
  var openedAt = Date.now();

  // Arrivals from the tap card (/card/ → /inquire/?via=card) get a greeting
  // and "we met in person" pre-selected. Nothing else changes.
  var via = '';
  try { via = new URLSearchParams(window.location.search).get('via') || ''; } catch (e) {}
  if (via === 'card') {
    var greet = document.getElementById('via-card');
    if (greet) greet.hidden = false;
    var source = form.querySelector('select[name="source"]');
    if (source && !source.value) source.value = 'in-person';
    var viaField = form.querySelector('input[name="via"]');
    if (viaField) viaField.value = 'card';
  }

  function all(name) {
    return Array.prototype.map.call(
      form.querySelectorAll('input[name="' + name + '"]:checked'),
      function (el) { return el.value; }
    );
  }
  function val(name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  // Clear the services error as soon as one is ticked.
  form.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'services' && all('services').length) servicesError.hidden = true;
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var services = all('services');
    if (!services.length) {
      servicesError.hidden = false;
      servicesError.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (!form.reportValidity()) return;

    errorLine.hidden = true;
    button.disabled = true;
    button.textContent = 'Sending…';

    var payload = {
      name: val('name'),
      email: val('email'),
      company: val('company'),
      role: val('role'),
      phone: val('phone'),
      handle: val('handle'),
      services: services,
      project: val('project'),
      platforms: all('platforms'),
      timing: val('timing'),
      budget: val('budget'),
      contact: val('contact'),
      source: val('source'),
      notes: val('notes'),
      via: val('via'),
      website: val('website'), // honeypot
      elapsedMs: Date.now() - openedAt,
    };

    fetch('/api/inquiry', {
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
          received.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      })
      .catch(function (err) {
        errorLine.textContent =
          err && err.message && err.message !== 'send-failed'
            ? err.message
            : "That didn't send — our side, not yours. Give it a moment and try again.";
        errorLine.hidden = false;
        button.disabled = false;
        button.textContent = 'Send inquiry';
      });
  });
})();
