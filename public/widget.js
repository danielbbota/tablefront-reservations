/**
 * TableFront booking widget.
 *
 * Embed:
 *   <div data-tablefront-widget data-restaurant="RESTAURANT_ID"></div>
 *   <script src="https://app.tablesfront.com/widget.js" async></script>
 *
 * Language follows the restaurant's dashboard setting (en/pt/de/fr);
 * override per-embed with data-lang="pt" on the mount div if ever needed.
 *
 * Theme by setting CSS custom properties on any ancestor of the mount div:
 *   --tf-accent  brand color for buttons/selection (default #8c4225)
 *   --tf-font    font-family (default: inherit from the page)
 *   --tf-radius  corner radius (default 10px)
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var ORIGIN = script ? new URL(script.src).origin : '';

  var I18N = {
    en: {
      date: 'Date', guests: 'Guests', time: 'Time', name: 'Name', phone: 'Phone',
      email: 'Email', notes: 'Special requests (optional)', book: 'Book table',
      booking: 'Booking…', pickDate: 'Pick a date to see available times.',
      checking: 'Checking availability…',
      full: 'Fully booked online for this party size — try another date, or contact us directly.',
      closed: 'Closed on this date — please pick another day.',
      loadError: 'Could not load availability. Please try again.',
      genericError: 'Something went wrong. Please try again.',
      confirmedTitle: 'Booking confirmed!',
      confirmedBody: '{date} at {time} for {party}. A confirmation email is on its way.',
      guest1: '1 guest', guestN: '{n} guests',
    },
    pt: {
      date: 'Data', guests: 'Pessoas', time: 'Hora', name: 'Nome', phone: 'Telefone',
      email: 'Email', notes: 'Pedidos especiais (opcional)', book: 'Reservar mesa',
      booking: 'A reservar…', pickDate: 'Escolha uma data para ver os horários disponíveis.',
      checking: 'A verificar disponibilidade…',
      full: 'Reservas online esgotadas para este número de pessoas — tente outra data ou contacte-nos diretamente.',
      closed: 'Fechado nesta data — por favor escolha outro dia.',
      loadError: 'Não foi possível carregar a disponibilidade. Tente novamente.',
      genericError: 'Algo correu mal. Tente novamente.',
      confirmedTitle: 'Reserva confirmada!',
      confirmedBody: '{date} às {time} para {party}. Vai receber um email de confirmação.',
      guest1: '1 pessoa', guestN: '{n} pessoas',
    },
    de: {
      date: 'Datum', guests: 'Gäste', time: 'Uhrzeit', name: 'Name', phone: 'Telefon',
      email: 'E-Mail', notes: 'Besondere Wünsche (optional)', book: 'Tisch reservieren',
      booking: 'Wird reserviert…', pickDate: 'Wählen Sie ein Datum, um verfügbare Zeiten zu sehen.',
      checking: 'Verfügbarkeit wird geprüft…',
      full: 'Online ausgebucht für diese Personenzahl — versuchen Sie ein anderes Datum oder kontaktieren Sie uns direkt.',
      closed: 'An diesem Datum geschlossen — bitte wählen Sie einen anderen Tag.',
      loadError: 'Verfügbarkeit konnte nicht geladen werden. Bitte erneut versuchen.',
      genericError: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
      confirmedTitle: 'Reservierung bestätigt!',
      confirmedBody: '{date} um {time} für {party}. Eine Bestätigungs-E-Mail ist unterwegs.',
      guest1: '1 Gast', guestN: '{n} Gäste',
    },
    fr: {
      date: 'Date', guests: 'Personnes', time: 'Heure', name: 'Nom', phone: 'Téléphone',
      email: 'Email', notes: 'Demandes particulières (facultatif)', book: 'Réserver une table',
      booking: 'Réservation…', pickDate: 'Choisissez une date pour voir les horaires disponibles.',
      checking: 'Vérification des disponibilités…',
      full: 'Complet en ligne pour ce nombre de personnes — essayez une autre date ou contactez-nous directement.',
      closed: 'Fermé à cette date — veuillez choisir un autre jour.',
      loadError: 'Impossible de charger les disponibilités. Veuillez réessayer.',
      genericError: 'Une erreur est survenue. Veuillez réessayer.',
      confirmedTitle: 'Réservation confirmée !',
      confirmedBody: '{date} à {time} pour {party}. Un email de confirmation est en route.',
      guest1: '1 personne', guestN: '{n} personnes',
    },
  };

  var CSS = [
    ':host{display:block;font-family:var(--tf-font,inherit);color:#1e1e1e;',
    '-webkit-font-smoothing:antialiased;}',
    '*{box-sizing:border-box;margin:0;}',
    '.tf-card{max-width:26rem;width:100%;}',
    '.tf-label{display:block;font-size:.8rem;font-weight:600;margin:.9rem 0 .3rem;',
    'letter-spacing:.02em;color:#1e1e1e;}',
    '.tf-input,.tf-select,.tf-textarea{width:100%;padding:.65rem .75rem;font:inherit;',
    'font-size:.9rem;border:1px solid #ddd3be;border-radius:var(--tf-radius,10px);',
    'background:#fff;color:#1e1e1e;}',
    '.tf-input:focus,.tf-select:focus,.tf-textarea:focus{outline:2px solid ',
    'var(--tf-accent,#8c4225);outline-offset:-1px;border-color:transparent;}',
    '.tf-row{display:flex;gap:.6rem;}',
    '.tf-row>*{flex:1;min-width:0;}',
    '.tf-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(4.4rem,1fr));',
    'gap:.4rem;}',
    '.tf-slot{padding:.55rem 0;font:inherit;font-size:.85rem;text-align:center;',
    'border:1px solid #ddd3be;border-radius:var(--tf-radius,10px);background:#fff;',
    'cursor:pointer;color:#1e1e1e;transition:border-color .15s;}',
    '.tf-slot:hover{border-color:var(--tf-accent,#8c4225);}',
    '.tf-slot.tf-selected{background:var(--tf-accent,#8c4225);color:#fff;',
    'border-color:var(--tf-accent,#8c4225);}',
    '.tf-btn{width:100%;margin-top:1.1rem;padding:.75rem;font:inherit;font-size:.9rem;',
    'font-weight:600;border:0;border-radius:var(--tf-radius,10px);cursor:pointer;',
    'background:var(--tf-accent,#8c4225);color:#fff;transition:opacity .15s;}',
    '.tf-btn:hover:not(:disabled){opacity:.9;}',
    '.tf-btn:disabled{opacity:.5;cursor:default;}',
    '.tf-muted{font-size:.85rem;color:#6b5f4b;margin-top:.6rem;}',
    '.tf-error{font-size:.85rem;color:#7c3a3a;margin-top:.6rem;}',
    '.tf-done{padding:1.5rem;border:1px solid #ddd3be;background:#fff;',
    'border-radius:var(--tf-radius,10px);text-align:center;}',
    '.tf-done h3{font-size:1.05rem;margin-bottom:.4rem;color:#1e1e1e;}',
    '.tf-done p{font-size:.9rem;color:#6b5f4b;}',
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

  function fmt(template, vars) {
    return template.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] != null ? vars[k] : '';
    });
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
      lang: mount.getAttribute('data-lang') || null,
      date: '',
      party: 2,
      time: null,
      slots: [],
      maxParty: 8,
      horizonDays: 60,
      loading: false,
    };

    function T(key) {
      var lang = I18N[state.lang] ? state.lang : 'en';
      return I18N[lang][key];
    }

    // Fetch restaurant config (language, limits), then render.
    fetch(ORIGIN + '/api/public/config?restaurant=' + encodeURIComponent(restaurantId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (cfg) {
        if (cfg) {
          if (!state.lang) state.lang = cfg.language;
          state.maxParty = cfg.maxPartySize || state.maxParty;
          state.horizonDays = cfg.horizonDays || state.horizonDays;
        }
        render();
      });

    function render() {
      var today = new Date();
      var maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + state.horizonDays);

      var dateInput = el('input', {
        class: 'tf-input',
        type: 'date',
        min: isoDate(today),
        max: isoDate(maxDate),
        'aria-label': T('date'),
      });

      var partySelect = el('select', { class: 'tf-select', 'aria-label': T('guests') });
      for (var i = 1; i <= state.maxParty; i++) {
        var opt = el('option', {
          value: String(i),
          text: i === 1 ? T('guest1') : fmt(T('guestN'), { n: i }),
        });
        if (i === state.party) opt.selected = true;
        partySelect.appendChild(opt);
      }

      var slotsWrap = el('div', { class: 'tf-slots' });
      var slotsMsg = el('p', { class: 'tf-muted', text: T('pickDate') });

      var nameInput = el('input', { class: 'tf-input', type: 'text', autocomplete: 'name', required: '' });
      var phoneInput = el('input', { class: 'tf-input', type: 'tel', autocomplete: 'tel', required: '' });
      var emailInput = el('input', { class: 'tf-input', type: 'email', autocomplete: 'email', required: '' });
      var notesInput = el('textarea', { class: 'tf-textarea', rows: '2' });

      var submitBtn = el('button', { class: 'tf-btn', type: 'submit', text: T('book') });
      var errorMsg = el('p', { class: 'tf-error' });
      errorMsg.hidden = true;

      function renderSlots() {
        slotsWrap.textContent = '';
        state.time = null;
        submitBtn.disabled = true;

        if (!state.date) {
          slotsMsg.textContent = T('pickDate');
          slotsMsg.hidden = false;
          return;
        }
        if (state.loading) {
          slotsMsg.textContent = T('checking');
          slotsMsg.hidden = false;
          return;
        }

        var open = state.slots.filter(function (s) {
          return s.remaining >= state.party;
        });
        if (!open.length) {
          slotsMsg.textContent = state.slots.length ? T('full') : T('closed');
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
        errorMsg.textContent = msg || '';
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
              showError(res.d.error || T('loadError'));
            } else {
              state.slots = res.d.slots;
            }
            renderSlots();
          })
          .catch(function () {
            state.loading = false;
            state.slots = [];
            showError(T('loadError'));
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

      var form = el('form', {}, [
        el('div', { class: 'tf-row' }, [
          el('div', {}, [el('label', { class: 'tf-label', text: T('date') }), dateInput]),
          el('div', {}, [el('label', { class: 'tf-label', text: T('guests') }), partySelect]),
        ]),
        el('label', { class: 'tf-label', text: T('time') }),
        slotsMsg,
        slotsWrap,
        el('label', { class: 'tf-label', text: T('name') }),
        nameInput,
        el('div', { class: 'tf-row' }, [
          el('div', {}, [el('label', { class: 'tf-label', text: T('phone') }), phoneInput]),
          el('div', {}, [el('label', { class: 'tf-label', text: T('email') }), emailInput]),
        ]),
        el('label', { class: 'tf-label', text: T('notes') }),
        notesInput,
        errorMsg,
        submitBtn,
      ]);
      submitBtn.disabled = true;
      root.textContent = '';
      root.appendChild(form);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!state.time) return;
        submitBtn.disabled = true;
        submitBtn.textContent = T('booking');
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
              submitBtn.textContent = T('book');
              showError(res.d.error || T('genericError'));
              if (res.d.code === 'SLOT_FULL') loadAvailability();
              return;
            }
            var b = res.d.booking;
            var party = b.partySize === 1 ? T('guest1') : fmt(T('guestN'), { n: b.partySize });
            root.textContent = '';
            root.appendChild(
              el('div', { class: 'tf-done' }, [
                el('h3', { text: T('confirmedTitle') }),
                el('p', { text: fmt(T('confirmedBody'), { date: b.date, time: b.time, party: party }) }),
              ])
            );
          })
          .catch(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = T('book');
            showError(T('genericError'));
          });
      });
    }
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
