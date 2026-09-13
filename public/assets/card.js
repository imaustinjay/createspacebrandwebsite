// The tap card — every button is live. Details come from the data-*
// attributes on <main>, so an address changes in one place (plus the .vcf).
(function () {
  var root = document.querySelector('main[data-email]');
  if (!root) return;

  var name = root.getAttribute('data-name') || '';
  var email = root.getAttribute('data-email') || '';
  var phone = (root.getAttribute('data-phone') || '').trim();
  var subject = root.getAttribute('data-subject') || '';
  var pageUrl = (document.querySelector('link[rel="canonical"]') || {}).href || window.location.href;

  // Email — a new message with the address (and a gentle subject) prefilled.
  var emailBtn = document.getElementById('act-email');
  if (emailBtn) {
    emailBtn.href = 'mailto:' + email + (subject ? '?subject=' + encodeURIComponent(subject) : '');
  }

  // Call/text only appears once a number is set on <main data-phone>.
  var callBtn = document.getElementById('act-call');
  if (callBtn && phone) {
    callBtn.href = 'tel:' + phone.replace(/[^\d+]/g, '');
    var sub = document.getElementById('act-call-sub');
    if (sub) sub.textContent = phone;
    callBtn.hidden = false;
  }

  // Toast for the small confirmations.
  var toast = document.getElementById('tap-toast');
  var toastTimer;
  function say(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1800);
  }

  // Share — the native sheet (AirDrop, Messages, etc.) where it exists.
  var shareBtn = document.getElementById('act-share');
  if (shareBtn && navigator.share) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', function () {
      navigator
        .share({
          title: root.getAttribute('data-share-title') || name,
          text: root.getAttribute('data-share-text') || '',
          url: pageUrl,
        })
        .catch(function () { /* dismissed — nothing to say */ });
    });
  }

  // Copy link — clipboard where allowed, a selectable prompt otherwise.
  var copyBtn = document.getElementById('act-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pageUrl).then(
          function () { say('Link copied'); },
          function () { window.prompt('Copy this link', pageUrl); }
        );
      } else {
        window.prompt('Copy this link', pageUrl);
      }
    });
  }

  // A visible press on every action so a tap always answers back.
  Array.prototype.forEach.call(document.querySelectorAll('.tap-btn'), function (btn) {
    var release = function () { btn.classList.remove('is-pressed'); };
    btn.addEventListener('pointerdown', function () { btn.classList.add('is-pressed'); });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  var saveBtn = document.querySelector('[data-action="save"]');
  if (saveBtn) saveBtn.addEventListener('click', function () { say('Opening contact card'); });
})();
