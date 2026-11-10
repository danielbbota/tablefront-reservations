/**
 * TableFront booking widget — stays (hotels, guesthouses, holiday rentals).
 *
 * Loaded on demand by widget.js when the business is a stays business; never
 * embedded directly. Flow: dates + guests → available units with the price
 * for the stay → guest details → reservation (or Stripe Checkout when the
 * business takes a deposit).
 */
(function () {
  'use strict';

  var I18N = {
    en: {
      checkIn: 'Check-in', checkOut: 'Check-out', guests: 'Guests',
      guest1: '1 guest', guestN: '{n} guests',
      night1: '1 night', nightN: '{n} nights',
      pickDates: 'Choose your dates to see what is available.',
      searching: 'Checking availability…',
      none: 'Nothing is available for these dates. Try other dates or fewer guests.',
      minNights: 'The minimum stay for these dates is {n} nights.',
      sleeps: 'Sleeps {n}',
      total: 'Total', cleaning: 'incl. cleaning fee {amount}',
      dueNow: 'To pay now: {amount}', payOnSite: 'Pay at the property',
      select: 'Select', selected: 'Selected', change: 'Change',
      notes: 'Requests or arrival time (optional)',
      reserve: 'Reserve', reservePay: 'Reserve and pay {amount}',
      reserving: 'Reserving…', redirecting: 'Taking you to secure payment…',
      confirmedTitle: 'Reservation confirmed!',
      confirmedBody: '{unit}, {checkIn} → {checkOut} ({nights}). A confirmation email is on its way.',
    },
    pt: {
      checkIn: 'Check-in', checkOut: 'Check-out', guests: 'Hóspedes',
      guest1: '1 hóspede', guestN: '{n} hóspedes',
      night1: '1 noite', nightN: '{n} noites',
      pickDates: 'Escolha as datas para ver a disponibilidade.',
      searching: 'A verificar disponibilidade…',
      none: 'Não há disponibilidade para estas datas. Experimente outras datas ou menos hóspedes.',
      minNights: 'A estadia mínima para estas datas é de {n} noites.',
      sleeps: 'Até {n} hóspedes',
      total: 'Total', cleaning: 'inclui taxa de limpeza de {amount}',
      dueNow: 'A pagar agora: {amount}', payOnSite: 'Pagamento no alojamento',
      select: 'Escolher', selected: 'Escolhido', change: 'Alterar',
      notes: 'Pedidos ou hora de chegada (opcional)',
      reserve: 'Reservar', reservePay: 'Reservar e pagar {amount}',
      reserving: 'A reservar…', redirecting: 'A encaminhar para o pagamento seguro…',
      confirmedTitle: 'Reserva confirmada!',
      confirmedBody: '{unit}, {checkIn} → {checkOut} ({nights}). Vai receber um email de confirmação.',
    },
    de: {
      checkIn: 'Check-in', checkOut: 'Check-out', guests: 'Gäste',
      guest1: '1 Gast', guestN: '{n} Gäste',
      night1: '1 Nacht', nightN: '{n} Nächte',
      pickDates: 'Wählen Sie Ihre Daten, um die Verfügbarkeit zu sehen.',
      searching: 'Verfügbarkeit wird geprüft…',
      none: 'Für diese Daten ist nichts verfügbar. Versuchen Sie andere Daten oder weniger Gäste.',
      minNights: 'Der Mindestaufenthalt für diese Daten beträgt {n} Nächte.',
      sleeps: 'Bis zu {n} Gäste',
      total: 'Gesamt', cleaning: 'inkl. Reinigungsgebühr {amount}',
      dueNow: 'Jetzt zu zahlen: {amount}', payOnSite: 'Zahlung in der Unterkunft',
      select: 'Auswählen', selected: 'Ausgewählt', change: 'Ändern',
      notes: 'Wünsche oder Ankunftszeit (optional)',
      reserve: 'Reservieren', reservePay: 'Reservieren und {amount} zahlen',
      reserving: 'Wird reserviert…', redirecting: 'Weiterleitung zur sicheren Zahlung…',
      confirmedTitle: 'Reservierung bestätigt!',
      confirmedBody: '{unit}, {checkIn} → {checkOut} ({nights}). Eine Bestätigungs-E-Mail ist unterwegs.',
    },
    fr: {
      checkIn: 'Arrivée', checkOut: 'Départ', guests: 'Voyageurs',
      guest1: '1 voyageur', guestN: '{n} voyageurs',
      night1: '1 nuit', nightN: '{n} nuits',
      pickDates: 'Choisissez vos dates pour voir les disponibilités.',
      searching: 'Vérification des disponibilités…',
      none: 'Rien de disponible pour ces dates. Essayez d’autres dates ou moins de voyageurs.',
      minNights: 'Le séjour minimum pour ces dates est de {n} nuits.',
      sleeps: 'Jusqu’à {n} voyageurs',
      total: 'Total', cleaning: 'frais de ménage de {amount} inclus',
      dueNow: 'À payer maintenant : {amount}', payOnSite: 'Paiement sur place',
      select: 'Choisir', selected: 'Choisi', change: 'Modifier',
      notes: 'Demandes ou heure d’arrivée (facultatif)',
      reserve: 'Réserver', reservePay: 'Réserver et payer {amount}',
      reserving: 'Réservation…', redirecting: 'Redirection vers le paiement sécurisé…',
      confirmedTitle: 'Réservation confirmée !',
      confirmedBody: '{unit}, {checkIn} → {checkOut} ({nights}). Un email de confirmation est en route.',
    },
  };

  var CSS = [
    '.tfs-units{display:grid;gap:.6rem;margin-top:.2rem;animation:tf-rise .3s ease-out both;}',
    '.tfs-unit{border:1px solid #ddd3be;border-radius:var(--tf-radius,10px);background:#fff;',
    'padding:.85rem .9rem;text-align:left;transition:border-color .15s,box-shadow .15s;}',
    '.tfs-unit.tf-selected{border-color:var(--tf-accent,#8c4225);',
    'box-shadow:0 0 0 1px var(--tf-accent,#8c4225);}',
    '.tfs-head{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem;}',
    '.tfs-name{font-size:.95rem;font-weight:600;color:#1e1e1e;}',
    '.tfs-price{font-size:.95rem;font-weight:600;color:#1e1e1e;white-space:nowrap;}',
    '.tfs-desc{font-size:.82rem;color:#6b5f4b;margin-top:.25rem;line-height:1.4;}',
    '.tfs-meta{font-size:.78rem;color:#6b5f4b;margin-top:.35rem;}',
    '.tfs-foot{display:flex;justify-content:space-between;align-items:center;gap:.75rem;margin-top:.6rem;}',
    '.tfs-pick{padding:.45rem .9rem;font:inherit;font-size:.82rem;font-weight:600;cursor:pointer;',
    'border:1px solid var(--tf-accent,#8c4225);border-radius:var(--tf-radius,10px);',
    'background:#fff;color:var(--tf-accent,#8c4225);transition:background .15s,color .15s;}',
    '.tfs-unit.tf-selected .tfs-pick{background:var(--tf-accent,#8c4225);color:#fff;}',
    '.tfs-details{animation:tf-rise .3s ease-out both;}',
    '.tfs-skel{height:5.2rem;}',
  ].join('');

  window.TableFrontWidget.register('stays', function (ctx) {
    var el = ctx.el;
    var fmt = ctx.fmt;
    var cfg = ctx.config || {};
    var S = I18N[ctx.lang] || I18N.en;
    ctx.addCss(CSS);

    var state = {
      checkIn: '',
      checkOut: '',
      guests: Math.min(2, cfg.maxGuests || 2),
      units: null, // null = not searched yet
      minNights: null,
      loading: false,
      selected: null,
      request: 0,
    };

    function plural(n, one, many) {
      return n === 1 ? S[one] : fmt(S[many], { n: n });
    }
    function addDays(iso, days) {
      var p = iso.split('-').map(Number);
      var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
      return d.toISOString().slice(0, 10);
    }

    var today = ctx.isoDate(new Date());
    var horizon = addDays(today, cfg.horizonDays || 365);

    var inInput = el('input', { class: 'tf-input', type: 'date', min: today, max: horizon, 'aria-label': S.checkIn });
    var outInput = el('input', { class: 'tf-input', type: 'date', min: addDays(today, 1), 'aria-label': S.checkOut });
    var guestSelect = el('select', { class: 'tf-select', 'aria-label': S.guests });
    for (var i = 1; i <= (cfg.maxGuests || 6); i++) {
      var opt = el('option', { value: String(i), text: plural(i, 'guest1', 'guestN') });
      if (i === state.guests) opt.selected = true;
      guestSelect.appendChild(opt);
    }

    var message = el('p', { class: 'tf-muted', text: S.pickDates });
    var unitsWrap = el('div', { class: 'tfs-units' });
    var detailsWrap = el('div', { class: 'tfs-details' });
    var errorMsg = el('p', { class: 'tf-error' });
    errorMsg.hidden = true;

    var nameInput = el('input', { class: 'tf-input', type: 'text', autocomplete: 'name', required: '' });
    var phoneInput = el('input', { class: 'tf-input', type: 'tel', autocomplete: 'tel', required: '' });
    var emailInput = el('input', { class: 'tf-input', type: 'email', autocomplete: 'email', required: '' });
    var notesInput = el('textarea', { class: 'tf-textarea', rows: '2' });
    var submitBtn = el('button', { class: 'tf-btn', type: 'submit' });

    function showError(msg) {
      errorMsg.textContent = msg || '';
      errorMsg.hidden = !msg;
    }

    function submitLabel() {
      var u = state.selected;
      return u && u.dueNowCents > 0
        ? fmt(S.reservePay, { amount: ctx.money(u.dueNowCents) })
        : S.reserve;
    }

    function renderDetails() {
      detailsWrap.textContent = '';
      if (!state.selected) return;
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel();
      [
        el('label', { class: 'tf-label', text: ctx.T('name') }),
        nameInput,
        el('div', { class: 'tf-row' }, [
          el('div', {}, [el('label', { class: 'tf-label', text: ctx.T('phone') }), phoneInput]),
          el('div', {}, [el('label', { class: 'tf-label', text: ctx.T('email') }), emailInput]),
        ]),
        el('label', { class: 'tf-label', text: S.notes }),
        notesInput,
        submitBtn,
      ].forEach(function (node) { detailsWrap.appendChild(node); });
    }

    function renderUnits() {
      unitsWrap.textContent = '';
      unitsWrap.removeAttribute('aria-busy');

      if (state.loading) {
        message.hidden = true;
        unitsWrap.setAttribute('aria-busy', 'true');
        unitsWrap.setAttribute('aria-label', S.searching);
        for (var k = 0; k < 2; k++) {
          unitsWrap.appendChild(el('div', { class: 'tf-skel tfs-skel', 'aria-hidden': 'true' }));
        }
        return;
      }
      if (state.units === null) {
        message.textContent = S.pickDates;
        message.hidden = false;
        return;
      }
      if (!state.units.length) {
        message.textContent = state.minNights ? fmt(S.minNights, { n: state.minNights }) : S.none;
        message.hidden = false;
        return;
      }

      message.hidden = true;
      state.units.forEach(function (u) {
        var isSelected = !!state.selected && state.selected.id === u.id;
        var pick = el('button', {
          class: 'tfs-pick',
          type: 'button',
          text: isSelected ? S.selected : S.select,
          'aria-pressed': isSelected ? 'true' : 'false',
        });
        var meta = [fmt(S.sleeps, { n: u.maxGuests }), plural(u.nights, 'night1', 'nightN')];
        if (u.cleaningFeeCents > 0) meta.push(fmt(S.cleaning, { amount: ctx.money(u.cleaningFeeCents) }));

        var card = el('div', { class: 'tfs-unit' + (isSelected ? ' tf-selected' : '') }, [
          el('div', { class: 'tfs-head' }, [
            el('span', { class: 'tfs-name', text: u.name }),
            el('span', { class: 'tfs-price', text: ctx.money(u.totalCents) }),
          ]),
        ]);
        if (u.description) card.appendChild(el('p', { class: 'tfs-desc', text: u.description }));
        card.appendChild(el('p', { class: 'tfs-meta', text: meta.join(' · ') }));
        card.appendChild(
          el('div', { class: 'tfs-foot' }, [
            el('span', {
              class: 'tfs-meta',
              text: u.dueNowCents > 0 ? fmt(S.dueNow, { amount: ctx.money(u.dueNowCents) }) : S.payOnSite,
            }),
            pick,
          ])
        );
        pick.addEventListener('click', function () {
          state.selected = u;
          showError(null);
          renderUnits();
          renderDetails();
        });
        unitsWrap.appendChild(card);
      });
    }

    function search() {
      state.selected = null;
      renderDetails();
      showError(null);
      if (!state.checkIn || !state.checkOut || state.checkOut <= state.checkIn) {
        state.units = null;
        state.loading = false;
        renderUnits();
        return;
      }
      state.loading = true;
      renderUnits();
      var ticket = ++state.request;

      ctx
        .getJson(
          '/api/public/stays/availability?restaurant=' + encodeURIComponent(ctx.businessId) +
            '&checkIn=' + encodeURIComponent(state.checkIn) +
            '&checkOut=' + encodeURIComponent(state.checkOut) +
            '&guests=' + encodeURIComponent(state.guests)
        )
        .then(function (res) {
          if (ticket !== state.request) return; // a newer search is running
          state.loading = false;
          if (!res.ok) {
            state.units = null;
            renderUnits();
            message.hidden = true;
            showError(res.d.error || ctx.T('loadError'));
            return;
          }
          state.units = res.d.units || [];
          state.minNights = res.d.minNights || null;
          renderUnits();
        });
    }

    inInput.addEventListener('change', function () {
      state.checkIn = inInput.value;
      if (state.checkIn) {
        outInput.min = addDays(state.checkIn, 1);
        outInput.max = addDays(state.checkIn, cfg.maxNights || 60);
        if (!state.checkOut || state.checkOut <= state.checkIn) {
          state.checkOut = addDays(state.checkIn, 1);
          outInput.value = state.checkOut;
        }
      }
      search();
    });
    outInput.addEventListener('change', function () {
      state.checkOut = outInput.value;
      search();
    });
    guestSelect.addEventListener('change', function () {
      state.guests = Number(guestSelect.value);
      search();
    });

    var form = el('form', {}, [
      el('div', { class: 'tf-row' }, [
        el('div', {}, [el('label', { class: 'tf-label', text: S.checkIn }), inInput]),
        el('div', {}, [el('label', { class: 'tf-label', text: S.checkOut }), outInput]),
      ]),
      el('label', { class: 'tf-label', text: S.guests }),
      guestSelect,
      el('div', { style: 'height:.9rem' }),
      message,
      unitsWrap,
      detailsWrap,
      // Outside detailsWrap on purpose: it must survive a new search (for
      // example "those dates were just taken").
      errorMsg,
    ]);
    ctx.root.textContent = '';
    ctx.root.appendChild(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var unit = state.selected;
      if (!unit) return;
      ctx.busy(submitBtn, S.reserving);
      showError(null);

      ctx
        .postJson('/api/public/stays/reservations', {
          restaurant: ctx.businessId,
          unit: unit.id,
          checkIn: state.checkIn,
          checkOut: state.checkOut,
          guests: state.guests,
          name: nameInput.value.trim(),
          phone: phoneInput.value.trim(),
          email: emailInput.value.trim(),
          notes: notesInput.value.trim(),
          lang: ctx.lang,
        })
        .then(function (res) {
          if (!res.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = submitLabel();
            showError(res.d.error || ctx.T('genericError'));
            if (res.d.code === 'DATES_TAKEN') {
              var msg = res.d.error;
              search();
              showError(msg);
            }
            return;
          }
          if (res.d.checkoutUrl) {
            ctx.busy(submitBtn, S.redirecting);
            window.location.href = res.d.checkoutUrl;
            return;
          }
          var r = res.d.reservation;
          ctx.root.textContent = '';
          ctx.root.appendChild(
            el('div', { class: 'tf-done' }, [
              ctx.checkIcon(),
              el('h3', { text: S.confirmedTitle }),
              el('p', {
                text: fmt(S.confirmedBody, {
                  unit: r.unit,
                  checkIn: ctx.formatDate(r.checkIn),
                  checkOut: ctx.formatDate(r.checkOut),
                  nights: plural(r.nights, 'night1', 'nightN'),
                }),
              }),
            ])
          );
        });
    });
  });
})();
