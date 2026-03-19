(function () {
  'use strict';

  var VIN_LENGTH = 17;
  var VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

  function isValidVIN(str) {
    return typeof str === 'string' && VIN_REGEX.test(str.replace(/\s/g, ''));
  }

  function formatVINInput(value) {
    return value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  }

  function setupVINInput(inputEl, counterEl) {
    if (!inputEl || !counterEl) return;
    function update() {
      var raw = inputEl.value;
      var formatted = formatVINInput(raw);
      if (raw !== formatted) inputEl.value = formatted;
      var len = formatted.length;
      counterEl.textContent = len + '/17';
      counterEl.classList.toggle('valid', len === VIN_LENGTH && isValidVIN(formatted));
      inputEl.classList.toggle('error', len > 0 && len < VIN_LENGTH);
      if (len === VIN_LENGTH && isValidVIN(formatted)) inputEl.classList.remove('error');
    }
    inputEl.addEventListener('input', update);
    inputEl.addEventListener('paste', function () { setTimeout(update, 0); });
    update();
  }

  function setupLookupTabs(container) {
    // VIN-only — no tab switching needed
  }

  /* ==========================================================
     Report Modal
     ========================================================== */
  function createModal() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'reportModal';
    overlay.innerHTML =
      '<div class="modal">' +
        '<button class="modal-close" id="modalClose">&times;</button>' +
        '<div class="modal-body" id="modalBody">' +
          '<div class="modal-loading"><div class="spinner"></div><p>Looking up vehicle...</p></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    document.getElementById('modalClose').addEventListener('click', closeModal);
  }

  function openModal() {
    var modal = document.getElementById('reportModal');
    if (!modal) { createModal(); modal = document.getElementById('reportModal'); }
    document.getElementById('modalBody').innerHTML =
      '<div class="modal-loading"><div class="spinner"></div><p>Looking up vehicle...</p></div>';
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    var modal = document.getElementById('reportModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function showModalError(msg) {
    document.getElementById('modalBody').innerHTML =
      '<div class="modal-error">' +
        '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
        '<h3>Something went wrong</h3>' +
        '<p>' + msg + '</p>' +
        '<button class="btn btn-primary" onclick="document.getElementById(\'reportModal\').classList.remove(\'open\');document.body.style.overflow=\'\'">Try Again</button>' +
      '</div>';
  }

  function showDecodeResult(data) {
    var d = data.data;
    var vehicleName = (d.year || '') + ' ' + (d.make || '') + ' ' + (d.model || '') + (d.trim ? ' ' + d.trim : '');

    // Check if user has credits
    fetch('/api/me')
      .then(function (r) { return r.json(); })
      .then(function (me) {
        var hasCredits = me.loggedIn && me.user.credits > 0;
        var creditCount = hasCredits ? me.user.credits : 0;

        var btnText = hasCredits
          ? 'Use 1 Credit (' + creditCount + ' remaining)'
          : 'Get Full Report — $5.99';

        var html =
          '<div class="modal-result">' +
            '<div class="modal-result-header">' +
              '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="16 10 11 15 8 12"/></svg>' +
              '<div>' +
                '<h3>Vehicle Found</h3>' +
                '<p class="modal-subtitle">' + vehicleName + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="modal-details">' +
              '<div class="detail-grid">' +
                makeRow('VIN', d.vin) +
                makeRow('Year', d.year) +
                makeRow('Make', d.make) +
                makeRow('Model', d.model) +
                makeRow('Trim', d.trim) +
                makeRow('Body', d.body_class) +
                makeRow('Type', d.vehicle_type) +
                makeRow('Engine', (d.engine_cylinders ? d.engine_cylinders + '-cyl' : '') + (d.engine_displacement ? ' ' + parseFloat(d.engine_displacement / 1000).toFixed(1) + 'L' : '') + (d.engine_hp ? ' ' + d.engine_hp + 'hp' : '')) +
                makeRow('Fuel', d.fuel_type) +
                makeRow('Transmission', d.transmission) +
                makeRow('Drive', d.drive_type) +
                makeRow('Doors', d.doors) +
                makeRow('Made In', d.plant_country) +
              '</div>' +
            '</div>' +
            '<div class="modal-cta">' +
              '<p class="modal-cta-text">Want the full vehicle history report?</p>' +
              '<p class="modal-cta-sub">Accidents, ownership, service records, title status — everything.</p>' +
              '<button class="btn btn-primary btn-block modal-buy-btn" data-vin="' + d.vin + '" data-name="' + vehicleName.replace(/"/g, '&quot;') + '" data-has-credits="' + (hasCredits ? '1' : '0') + '">' + btnText + '</button>' +
            '</div>' +
          '</div>';
        document.getElementById('modalBody').innerHTML = html;

        document.querySelector('.modal-buy-btn').addEventListener('click', function () {
          var vin = this.getAttribute('data-vin');
          var name = this.getAttribute('data-name');
          if (this.getAttribute('data-has-credits') === '1') {
            useCredit(vin, name);
          } else {
            redirectToCheckout(vin, name);
          }
        });
      });
  }

  function makeRow(label, value) {
    if (!value && value !== 0) return '';
    return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
  }

  /* ==========================================================
     API Calls
     ========================================================== */
  function fetchDecode(vin) {
    openModal();
    fetch('/api/decode?vin=' + encodeURIComponent(vin))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success && data.data) {
          showDecodeResult(data);
        } else {
          showModalError(data.error || 'Could not find vehicle data for this VIN.');
        }
      })
      .catch(function () {
        showModalError('Network error. Please check your connection and try again.');
      });
  }

  function useCredit(vin, vehicleName) {
    document.getElementById('modalBody').innerHTML =
      '<div class="modal-loading"><div class="spinner"></div><p>Generating your report...</p></div>';

    fetch('/api/use-credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin: vin, vehicle_name: vehicleName })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.success && data.data && data.data.html_content) {
          // Redirect to a page that displays the report
          closeModal();
          var reportWin = window.open('', '_blank');
          if (reportWin) {
            reportWin.document.write(data.data.html_content);
            reportWin.document.close();
          } else {
            // Fallback: show in modal via iframe
            document.getElementById('modalBody').innerHTML =
              '<div style="text-align:center;padding:1.5rem;">' +
                '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" style="margin:0 auto 0.75rem;display:block;"><circle cx="12" cy="12" r="10"/><polyline points="16 10 11 15 8 12"/></svg>' +
                '<h3 style="margin-bottom:0.25rem;">Report ready!</h3>' +
                '<p style="color:#6b7280;margin-bottom:1rem;">1 credit used. ' + (data.remaining_credits || 0) + ' remaining.</p>' +
                '<p style="color:#6b7280;font-size:0.8125rem;">Your report opened in a new tab. If it didn\'t open, check your popup blocker.</p>' +
              '</div>';
          }
        } else {
          showModalError(data.error || 'Could not generate report.');
        }
      })
      .catch(function () {
        showModalError('Network error. Please try again.');
      });
  }

  function redirectToCheckout(vin, vehicleName) {
    document.getElementById('modalBody').innerHTML =
      '<div class="modal-loading"><div class="spinner"></div><p>Redirecting to checkout...</p></div>';

    fetch('/api/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vin: vin, vehicle_name: vehicleName })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.url) {
          window.location.href = data.url;
        } else {
          showModalError(data.error || 'Could not create checkout session.');
        }
      })
      .catch(function () {
        showModalError('Network error. Please check your connection and try again.');
      });
  }

  /* ==========================================================
     Form Submit
     ========================================================== */
  function setupLookupForm(form) {
    if (!form) return;
    var input = form.querySelector('input[name="vin"]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var card = form.closest('.lookup-card');
      var activeTab = card && card.querySelector('.lookup-tab.active');
      var mode = activeTab ? activeTab.getAttribute('data-mode') : 'vin';
      var value = input ? input.value.trim() : '';

      if (mode === 'vin') {
        var formatted = formatVINInput(value);
        if (formatted.length !== VIN_LENGTH || !isValidVIN(formatted)) {
          if (input) { input.classList.add('error'); input.focus(); }
          return;
        }
        if (input) input.classList.remove('error');
        fetchDecode(formatted);
      } else {
        if (!value) {
          if (input) { input.classList.add('error'); input.focus(); }
          return;
        }
        if (input) input.classList.remove('error');
        fetchDecode(value);
      }
    });
  }

  /* ==========================================================
     Accordion
     ========================================================== */
  function setupAccordion() {
    var triggers = document.querySelectorAll('.accordion-trigger');
    triggers.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var expanded = btn.getAttribute('aria-expanded') === 'true';
        var panel = document.getElementById(btn.getAttribute('aria-controls'));
        triggers.forEach(function (other) {
          other.setAttribute('aria-expanded', 'false');
          var p = document.getElementById(other.getAttribute('aria-controls'));
          if (p) p.style.maxHeight = null;
        });
        if (!expanded && panel) {
          btn.setAttribute('aria-expanded', 'true');
          panel.style.maxHeight = panel.scrollHeight + 'px';
        }
      });
    });
  }

  /* ==========================================================
     Navbar
     ========================================================== */
  function setupNavbar() {
    var navbar = document.getElementById('navbar');
    var toggle = document.getElementById('navToggle');
    var links = document.getElementById('navLinks');
    if (!navbar) return;

    var ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        requestAnimationFrame(function () {
          navbar.classList.toggle('scrolled', window.scrollY > 10);
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
    navbar.classList.toggle('scrolled', window.scrollY > 10);

    if (toggle && links) {
      toggle.addEventListener('click', function () {
        toggle.classList.toggle('open');
        links.classList.toggle('open');
      });
      links.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () {
          toggle.classList.remove('open');
          links.classList.remove('open');
        });
      });
    }
  }

  /* ==========================================================
     Scroll Reveal
     ========================================================== */
  function setupReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
    els.forEach(function (el) { observer.observe(el); });
  }

  function setupSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var href = a.getAttribute('href');
        if (href === '#') return;
        var target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          var offset = 64;
          var top = target.getBoundingClientRect().top + window.scrollY - offset;
          window.scrollTo({ top: top, behavior: 'smooth' });
        }
      });
    });
  }

  /* ==========================================================
     Live Purchase Notification
     ========================================================== */
  function setupLiveNotification() {
    var el = document.getElementById('liveNotif');
    if (!el) return;
    var entries = [
      { loc: 'Georgia', car: '2020 Kia Sorento' },
      { loc: 'Texas', car: '2018 Toyota Camry' },
      { loc: 'California', car: '2021 Honda Civic' },
      { loc: 'Florida', car: '2019 Ford F-150' },
      { loc: 'New York', car: '2017 BMW 3 Series' },
      { loc: 'Ohio', car: '2022 Chevrolet Malibu' },
      { loc: 'Arizona', car: '2020 Nissan Altima' },
      { loc: 'Washington', car: '2019 Tesla Model 3' },
      { loc: 'Illinois', car: '2021 Hyundai Tucson' },
      { loc: 'Colorado', car: '2018 Subaru Outback' },
    ];
    var idx = 0;
    function show() {
      var e = entries[idx % entries.length];
      el.innerHTML =
        '<div class="notif-header"><strong>Someone in ' + e.loc + '</strong><button class="notif-close" aria-label="Close">&times;</button></div>' +
        '<div class="notif-body">purchased a report for a ' + e.car + '</div>' +
        '<div class="notif-time">just now</div>';
      el.classList.add('show');
      var closeBtn = el.querySelector('.notif-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { el.classList.remove('show'); });
      setTimeout(function () { el.classList.remove('show'); }, 5000);
      idx++;
    }
    setTimeout(function () { show(); setInterval(show, 30000); }, 8000);
  }

  /* ==========================================================
     Auth UI in Navbar
     ========================================================== */
  function setupAuthUI() {
    var navInner = document.querySelector('.nav-inner');
    if (!navInner) return;

    var authContainer = document.createElement('div');
    authContainer.className = 'nav-auth';
    authContainer.id = 'navAuth';

    var toggle = navInner.querySelector('.nav-toggle');
    if (toggle) {
      navInner.insertBefore(authContainer, toggle);
    } else {
      navInner.appendChild(authContainer);
    }

    fetch('/api/me')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.loggedIn) {
          var initials = data.user.name.split(' ').map(function (n) { return n[0]; }).join('').toUpperCase().substring(0, 2);
          var creditsBadge = data.user.credits > 0
            ? '<span class="nav-credits-badge">' + data.user.credits + ' credits</span>'
            : '';

          authContainer.innerHTML =
            creditsBadge +
            '<div class="nav-user">' +
              '<div class="nav-user-avatar" id="userAvatar">' + initials + '</div>' +
              '<div class="nav-user-dropdown" id="userDropdown">' +
                '<div class="nav-user-info">' +
                  '<div class="nav-user-name">' + data.user.name + '</div>' +
                  '<div class="nav-user-email">' + data.user.email + '</div>' +
                  (data.user.credits > 0 ? '<div style="font-size:0.75rem;color:#16a34a;font-weight:600;margin-top:0.25rem;">' + data.user.credits + ' report credits</div>' : '') +
                '</div>' +
                '<a href="dashboard.html">My Reports</a>' +
                '<a href="pricing.html">Buy Credits</a>' +
                '<button class="logout-btn" id="logoutBtn">Log Out</button>' +
              '</div>' +
            '</div>';

          var avatar = document.getElementById('userAvatar');
          var dropdown = document.getElementById('userDropdown');
          avatar.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.classList.toggle('open');
          });
          document.addEventListener('click', function () {
            dropdown.classList.remove('open');
          });

          document.getElementById('logoutBtn').addEventListener('click', function () {
            fetch('/api/logout', { method: 'POST' }).then(function () {
              window.location.reload();
            });
          });
        } else {
          authContainer.innerHTML =
            '<a href="login.html" class="nav-auth-link">Log in</a>' +
            '<a href="signup.html" class="nav-auth-btn">Sign Up</a>';
        }
      })
      .catch(function () {
        authContainer.innerHTML =
          '<a href="login.html" class="nav-auth-link">Log in</a>' +
          '<a href="signup.html" class="nav-auth-btn">Sign Up</a>';
      });
  }

  /* ==========================================================
     Buy Credits Buttons
     ========================================================== */
  function setupBuyCreditsButtons() {
    document.querySelectorAll('.buy-credits-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var bundle = this.getAttribute('data-bundle');
        var originalText = this.textContent;
        this.disabled = true;
        this.textContent = 'Redirecting…';

        fetch('/api/buy-credits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle: bundle })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.url) {
              window.location.href = data.url;
            } else if (data.redirect) {
              window.location.href = data.redirect;
            } else {
              alert(data.error || 'Something went wrong.');
              btn.disabled = false;
              btn.textContent = originalText;
            }
          })
          .catch(function () {
            alert('Network error. Please try again.');
            btn.disabled = false;
            btn.textContent = originalText;
          });
      });
    });
  }

  /* ==========================================================
     Init
     ========================================================== */
  function init() {
    setupNavbar();
    setupAuthUI();
    setupReveal();
    setupSmoothScroll();
    setupBuyCreditsButtons();
    setupVINInput(document.getElementById('vinInput'), document.getElementById('vinCounter'));
    setupVINInput(document.getElementById('vinInputBottom'), document.getElementById('vinCounterBottom'));
    document.querySelectorAll('.lookup-card').forEach(function (card) { setupLookupTabs(card); });
    setupLookupForm(document.getElementById('lookupForm'));
    setupLookupForm(document.getElementById('lookupFormBottom'));
    setupAccordion();
    setupLiveNotification();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
