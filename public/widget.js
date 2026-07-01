/**
 * TableFront booking widget.
 *
 * Embed:
 *   <div data-tablefront-widget data-restaurant="RESTAURANT_ID"></div>
 *   <script src="https://app.tablesfront.com/widget.js" async></script>
 *
 * Theme by setting CSS custom properties on any ancestor of the mount div:
 *   --tf-accent  brand color for buttons/selection (default #1a1a1a)
 *   --tf-font    font-family (default: inherit from the page)
 *   --tf-radius  corner radius (default 10px)
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ORIGIN = script ? new URL(script.src).origin : '';

  var CSS = [
    ':host{display:block;font-family:var(--tf-font,inherit);color:#1f1f1f;',
    '-webkit-font-smoothing:antialiased;}',
    '*{box-sizing:border-box;margin:0;}',
    '.tf-card{max-width:26rem;width:100%;}',
    '.tf-label{display:block;font-size:.8rem;font-weight:600;margin:.9rem 0 .3rem;',
    'letter-spacing:.02em;}',
    '.tf-input,.tf-select,.tf-textarea{width:100%;padding:.6rem .7rem;font:inherit;',
    'font-size:.9rem;border:1px solid #d4d4d4;border-radius:var(--tf-radius,10px);',
    'background:#fff;color:inherit;}',
    '.tf-input:focus,.tf-select:focus,.tf-textarea:focus{outline:2px solid ',
    'var(--tf-accent,#1a1a1a);outline-offset:-1px;border-color:transparent;}',
    '.tf-row{display:flex;gap:.6rem;}',
    '.tf-row>*{flex:1;min-width:0;}',
    '.tf-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(4.4rem,1fr));',
    'gap:.4rem;}',
    '.tf-slot{padding:.5rem 0;font:inherit;font-size:.85rem;text-align:center;',
    'border:1px solid #d4d4d4;border-radius:var(--tf-radius,10px);background:#fff;',
    'cursor:pointer;color:inherit;}',
    '.tf-slot:hover{border-color:var(--tf-accent,#1a1a1a);}',
    '.tf-slot.tf-selected{background:var(--tf-accent,#1a1a1a);color:#fff;',
    'border-color:var(--tf-accent,#1a1a1a);}',
    '.tf-btn{width:100%;margin-top:1.1rem;padding:.7rem;font:inherit;font-size:.9rem;',
    'font-weight:600;border:0;border-radius:var(--tf-radius,10px);cursor:pointer;',
    'background:var(--tf-accent,#1a1a1a);color:#fff;}',
    '.tf-btn:disabled{opacity:.5;cursor:default;}',
    '.tf-muted{font-size:.85rem;color:#737373;margin-top:.6rem;}',
    '.tf-error{font-size:.85rem;color:#b91c1c;margin-top:.6rem;}',
    '.tf-done{padding:1.4rem;border:1px solid #d4d4d4;',
    'border-radius:var(--tf-radius,10px);text-align:center;}',
    '.tf-done h3{font-size:1.05rem;margin-bottom:.4rem;}',
    '.tf-done p{font-size:.9rem;color:#525252;}',
    '@media (max-width:420px){.tf-row{flex-direction:column;gap:0;}}',
  ].join('');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function isoDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function initWidget(mount) {
    var restaurantId = mount.getAttribute('data-restaurant');
    if (!restaurantId || mount.__tfInit) return;
    mount.__tfInit = true;

    var shadow = mount.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var root = el('div', { class: 'tf-card' });
    shadow.appendChild(root);

    var state = {
      date: '',
      party: 2,
      time: null,
      slots: [],
      maxParty: 8,
      horizonDays: 60,
      loading: false,
      error: null,
    };

    // --- controls -----------------------------------------------------------
    var today = new Date();
    var maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + state.horizonDays);

    var dateInput = el('input', {
      class: 'tf-input',
      type: 'date',
      min: isoDate(today),
      max: isoDate(maxDate),
      'aria-label': 'Booking date',
    });

    var partySelect = el('select', { class: 'tf-select', 'aria-label': 'Party size' });

    var slotsWrap = el('div', { class: 'tf-slots' });
    var slotsMsg = el('p', { class: 'tf-muted', text: 'Pick a date to see available times.' });

    var nameInput = el('input', { class: 'tf-input', type: 'text', autocomplete: 'name', required: '' });
    var phoneInput = el('input', { class: 'tf-input', type: 'tel', autocomplete: 'tel', required: '' });
    var emailInput = el('input', { class: 'tf-input', type: 'email', autocomplete: 'email', required: '' });
    var notesInput = el('textarea', { class: 'tf-textarea', rows: '2' });

    var submitBtn = el('button', { class: 'tf-btn', type: 'submit', text: 'Book table' });
    var errorMsg = el('p', { class: 'tf-error' });
    errorMsg.hidden = true;

    function fillPartySelect() {
      partySelect.textContent = '';
      for (var i = 1; i <= state.maxParty; i++) {
        var opt = el('option', {
          value: String(i),
          text: i === 1 ? '1 guest' : i + ' guests',
        });
        if (i === state.party) opt.selected = true;
        partySelect.appendChild(opt);
      }
    }
    fillPartySelect();

    // --- rendering ----------------------------------------------------------
    function renderSlots() {
      slotsWrap.textContent = '';
      state.time = null;
      submitBtn.disabled = true;

      if (!state.date) {
        slotsMsg.textContent = 'Pick a date to see available times.';
        slotsMsg.hidden = false;
        return;
      }
      if (state.loading) {
        slotsMsg.textContent = 'Checking availability…';
        slotsMsg.hidden = false;
        return;
      }

      var open = state.slots.filter(function (s) {
        return s.remaining >= state.party;
      });
      if (!open.length) {
        slotsMsg.textContent = state.slots.length
          ? 'Fully booked online for this party size — try another date, or contact us directly.'
          : 'Closed on this date — please pick another day.';
        slotsMsg.hidden = false;
        return;
      }

      slotsMsg.hidden = true;
      open.forEach(function (s) {
        var b = el('button', { class: 'tf-slot', type: 'button', text: s.time });
        b.addEventListener('click', function () {
          state.time = s.time;
          slotsWrap.querySelectorAll('.tf-slot').forEach(function (n) {
            n.classList.remove('tf-selected');
          });
          b.classList.add('tf-selected');
          submitBtn.disabled = false;
        });
        slotsWrap.appendChild(b);
      });
    }

    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.hidden = !msg;
    }

    function loadAvailability() {
      if (!state.date) return;
      state.loading = true;
      showError(null);
      renderSlots();

      fetch(
        ORIGIN + '/api/public/availability?restaurant=' +
          encodeURIComponent(restaurantId) + '&date=' + encodeURIComponent(state.date)
      )
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          state.loading = false;
          if (!res.ok) {
            state.slots = [];
            showError(res.d.error || 'Could not load availability.');
          } else {
            state.slots = res.d.slots;
            if (res.d.maxPartySize && res.d.maxPartySize !== state.maxParty) {
              state.maxParty = res.d.maxPartySize;
              fillPartySelect();
            }
          }
          renderSlots();
        })
        .catch(function () {
          state.loading = false;
          state.slots = [];
          showError('Could not load availability. Please try again.');
          renderSlots();
        });
    }

    dateInput.addEventListener('change', function () {
      state.date = dateInput.value;
      loadAvailability();
    });
    partySelect.addEventListener('change', function () {
      state.party = Number(partySelect.value);
      renderSlots();
    });

    // --- form ---------------------------------------------------------------
    var form = el('form', {}, [
      el('div', { class: 'tf-row' }, [
        el('div', {}, [el('label', { class: 'tf-label', text: 'Date' }), dateInput]),
        el('div', {}, [el('label', { class: 'tf-label', text: 'Guests' }), partySelect]),
      ]),
      el('label', { class: 'tf-label', text: 'Time' }),
      slotsMsg,
      slotsWrap,
      el('label', { class: 'tf-label', text: 'Name' }),
      nameInput,
      el('div', { class: 'tf-row' }, [
        el('div', {}, [el('label', { class: 'tf-label', text: 'Phone' }), phoneInput]),
        el('div', {}, [el('label', { class: 'tf-label', text: 'Email' }), emailInput]),
      ]),
      el('label', { class: 'tf-label', text: 'Special requests (optional)' }),
      notesInput,
      errorMsg,
      submitBtn,
    ]);
    submitBtn.disabled = true;
    root.appendChild(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!state.time) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Booking…';
      showError(null);

      fetch(ORIGIN + '/api/public/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurant: restaurantId,
          date: state.date,
          time: state.time,
          partySize: state.party,
          name: nameInput.value.trim(),
          phone: phoneInput.value.trim(),
          email: emailInput.value.trim(),
          notes: notesInput.value.trim(),
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Book table';
            showError(res.d.error || 'Could not complete the booking.');
            if (res.d.code === 'SLOT_FULL') loadAvailability();
            return;
          }
          var b = res.d.booking;
          root.textContent = '';
          root.appendChild(
            el('div', { class: 'tf-done' }, [
              el('h3', { text: 'Booking confirmed!' }),
              el('p', {
                text:
                  b.date + ' at ' + b.time + ' for ' + b.partySize +
                  (b.partySize === 1 ? ' guest' : ' guests') +
                  '. A confirmation email is on its way.',
              }),
            ])
          );
        })
        .catch(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Book table';
          showError('Something went wrong. Please try again.');
        });
    });
  }

  function initAll() {
    document.querySelectorAll('[data-tablefront-widget]').forEach(initWidget);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
