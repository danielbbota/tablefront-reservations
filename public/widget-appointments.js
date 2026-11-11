/**
 * TableFront booking widget — appointments (clinics, barbers, salons).
 *
 * Not embedded directly: widget.js loads this file when the business is an
 * appointments business and calls the renderer registered below with a
 * context (see makeContext in widget.js).
 *
 * Guest flow: service → professional → date → time → contact details.
 * When the business charges online the guest is sent on to Stripe Checkout;
 * otherwise the appointment is confirmed on the spot.
 */
(function () {
  'use strict';

  var I18N = {
    en: {
      service: 'Service', professional: 'Professional', anyPro: 'Any professional',
      change: 'Change', date: 'Date', time: 'Time',
      notes: 'Notes (optional)', minutes: '{n} min',
      pickDate: 'Pick a date to see available times.',
      checking: 'Checking availability…',
      none: 'No free times on this day — try another date or professional.',
      book: 'Book appointment', booking: 'Booking…',
      pay: 'Continue to payment', dueNow: '{amount} to pay now, the rest on site.',
      dueNowFull: '{amount} to pay now.',
      redirecting: 'Taking you to the secure payment page…',
      taken: 'Sorry, that time was just taken. Please pick another one.',
      unavailable: 'Online booking is not available yet. Please contact us directly.',
      confirmedTitle: 'Appointment confirmed!',
      confirmedBody: '{service} on {date} at {time}.',
      withStaff: 'With {staff}.',
      emailNote: 'A confirmation email is on its way.',
    },
    pt: {
      service: 'Serviço', professional: 'Profissional', anyPro: 'Qualquer profissional',
      change: 'Alterar', date: 'Data', time: 'Hora',
      notes: 'Notas (opcional)', minutes: '{n} min',
      pickDate: 'Escolha uma data para ver os horários disponíveis.',
      checking: 'A verificar disponibilidade…',
      none: 'Sem horários livres neste dia — tente outra data ou outro profissional.',
      book: 'Marcar', booking: 'A marcar…',
      pay: 'Continuar para o pagamento', dueNow: '{amount} a pagar agora, o restante no local.',
      dueNowFull: '{amount} a pagar agora.',
      redirecting: 'A encaminhar para a página de pagamento seguro…',
      taken: 'Esse horário acabou de ser ocupado. Por favor escolha outro.',
      unavailable: 'As marcações online ainda não estão disponíveis. Por favor contacte-nos diretamente.',
      confirmedTitle: 'Marcação confirmada!',
      confirmedBody: '{service} no dia {date} às {time}.',
      withStaff: 'Com {staff}.',
      emailNote: 'Vai receber um email de confirmação.',
    },
    de: {
      service: 'Leistung', professional: 'Fachkraft', anyPro: 'Beliebige Fachkraft',
      change: 'Ändern', date: 'Datum', time: 'Uhrzeit',
      notes: 'Anmerkungen (optional)', minutes: '{n} Min.',
      pickDate: 'Wählen Sie ein Datum, um verfügbare Zeiten zu sehen.',
      checking: 'Verfügbarkeit wird geprüft…',
      none: 'Keine freien Zeiten an diesem Tag — versuchen Sie ein anderes Datum oder eine andere Fachkraft.',
      book: 'Termin buchen', booking: 'Wird gebucht…',
      pay: 'Weiter zur Zahlung', dueNow: '{amount} jetzt zu zahlen, der Rest vor Ort.',
      dueNowFull: '{amount} jetzt zu zahlen.',
      redirecting: 'Sie werden zur sicheren Zahlungsseite weitergeleitet…',
      taken: 'Diese Zeit wurde gerade vergeben. Bitte wählen Sie eine andere.',
      unavailable: 'Die Online-Buchung ist noch nicht verfügbar. Bitte kontaktieren Sie uns direkt.',
      confirmedTitle: 'Termin bestätigt!',
      confirmedBody: '{service} am {date} um {time}.',
      withStaff: 'Bei {staff}.',
      emailNote: 'Eine Bestätigungs-E-Mail ist unterwegs.',
    },
    fr: {
      service: 'Prestation', professional: 'Professionnel', anyPro: "N'importe quel professionnel",
      change: 'Modifier', date: 'Date', time: 'Heure',
      notes: 'Remarques (facultatif)', minutes: '{n} min',
      pickDate: 'Choisissez une date pour voir les horaires disponibles.',
      checking: 'Vérification des disponibilités…',
      none: 'Aucun créneau libre ce jour-là — essayez une autre date ou un autre professionnel.',
      book: 'Prendre rendez-vous', booking: 'Réservation…',
      pay: 'Continuer vers le paiement', dueNow: '{amount} à payer maintenant, le reste sur place.',
      dueNowFull: '{amount} à payer maintenant.',
      redirecting: 'Redirection vers la page de paiement sécurisé…',
      taken: "Ce créneau vient d'être pris. Veuillez en choisir un autre.",
      unavailable: "La réservation en ligne n'est pas encore disponible. Veuillez nous contacter directement.",
      confirmedTitle: 'Rendez-vous confirmé !',
      confirmedBody: '{service} le {date} à {time}.',
      withStaff: 'Avec {staff}.',
      emailNote: 'Un email de confirmation est en route.',
    },
  };

  var CSS = [
    '.tfa-cat{font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;',
    'color:#6b5f4b;margin:.8rem 0 .35rem;}',
    '.tfa-svc{display:flex;justify-content:space-between;align-items:center;gap:.75rem;',
    'width:100%;padding:.7rem .8rem;margin-bottom:.4rem;font:inherit;font-size:.9rem;',
    'text-align:left;border:1px solid #ddd3be;border-radius:var(--tf-radius,10px);',
    'background:#fff;color:#1e1e1e;cursor:pointer;transition:border-color .15s,transform .15s;}',
    '.tfa-svc:hover{border-color:var(--tf-accent,#8c4225);}',
    '.tfa-svc:active{transform:scale(.99);}',
    '.tfa-svc.tfa-on{border-color:var(--tf-accent,#8c4225);',
    'box-shadow:inset 0 0 0 1px var(--tf-accent,#8c4225);cursor:default;}',
    '.tfa-svc b{display:block;font-weight:600;}',
    '.tfa-svc small{display:block;margin-top:.1rem;font-size:.78rem;color:#6b5f4b;}',
    '.tfa-price{font-weight:600;white-space:nowrap;}',
    '.tfa-change{margin:0 0 .2rem;padding:.2rem 0;font:inherit;font-size:.8rem;font-weight:600;',
    'border:0;background:none;cursor:pointer;color:var(--tf-accent,#8c4225);text-decoration:underline;}',
    '.tfa-sum{margin-top:1rem;padding:.7rem .8rem;border-radius:var(--tf-radius,10px);',
    'background:#f5efe0;font-size:.85rem;color:#1e1e1e;}',
    '[hidden]{display:none!important;}',
  ].join('');

  function render(ctx) {
    var el = ctx.el;
    var fmt = ctx.fmt;
    var S = I18N[ctx.lang] || I18N.en;
    var root = ctx.root;
    ctx.addCss(CSS);

    var state = {
      services: [],
      staff: [],
      serviceId: null,
      staffId: 'any',
      date: '',
      time: null,
      slots: [],
      loading: false,
      request: 0,
    };

    function service() {
      for (var i = 0; i < state.services.length; i++) {
        if (state.services[i].id === state.serviceId) return state.services[i];
      }
      return null;
    }

    function staffFor(serviceId) {
      return state.staff.filter(function (m) {
        return m.serviceIds.indexOf(serviceId) !== -1;
      });
    }

    function serviceMeta(s) {
      var parts = [fmt(S.minutes, { n: s.durationMinutes })];
      if (s.description) parts.push(s.description);
      return parts.join(' · ');
    }

    root.textContent = '';
    for (var k = 0; k < 3; k++) root.appendChild(el('div', { class: 'tf-skel', 'aria-hidden': 'true', style: 'margin-bottom:.4rem' }));

    ctx.getJson('/api/public/appointments/catalog?restaurant=' + encodeURIComponent(ctx.businessId))
      .then(function (res) {
        if (!res.ok) return ctx.fail();
        state.services = res.d.services || [];
        state.staff = res.d.staff || [];
        if (!state.services.length) {
          root.textContent = '';
          root.appendChild(el('p', { class: 'tf-muted', text: S.unavailable }));
          return;
        }
        if (state.services.length === 1) state.serviceId = state.services[0].id;
        build();
      });

    function build() {
      var today = new Date();
      var maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + (ctx.config.horizonDays || 90));

      var servicesWrap = el('div', {});
      var staffSelect = el('select', { class: 'tf-select', 'aria-label': S.professional });
      var dateInput = el('input', {
        class: 'tf-input',
        type: 'date',
        min: ctx.isoDate(today),
        max: ctx.isoDate(maxDate),
        'aria-label': S.date,
      });
      var slotsWrap = el('div', { class: 'tf-slots' });
      var slotsMsg = el('p', { class: 'tf-muted', text: S.pickDate });
      var nameInput = el('input', { class: 'tf-input', type: 'text', autocomplete: 'name', required: '', maxlength: '120' });
      var phoneInput = el('input', { class: 'tf-input', type: 'tel', autocomplete: 'tel', required: '', maxlength: '40' });
      var emailInput = el('input', { class: 'tf-input', type: 'email', autocomplete: 'email', required: '' });
      var notesInput = el('textarea', { class: 'tf-textarea', rows: '2', maxlength: '1000' });
      var summary = el('p', { class: 'tfa-sum' });
      var errorMsg = el('p', { class: 'tf-error', role: 'alert' });
      var submitBtn = el('button', { class: 'tf-btn', type: 'submit', text: S.book });
      errorMsg.hidden = true;
      summary.hidden = true;

      // Everything below the service list appears once a service is chosen.
      var rest = el('div', {}, [
        el('div', { class: 'tf-row' }, [
          el('div', {}, [el('label', { class: 'tf-label', text: S.professional }), staffSelect]),
          el('div', {}, [el('label', { class: 'tf-label', text: S.date }), dateInput]),
        ]),
        el('label', { class: 'tf-label', text: S.time }),
        slotsMsg,
        slotsWrap,
        el('label', { class: 'tf-label', text: ctx.T('name') }),
        nameInput,
        el('div', { class: 'tf-row' }, [
          el('div', {}, [el('label', { class: 'tf-label', text: ctx.T('phone') }), phoneInput]),
          el('div', {}, [el('label', { class: 'tf-label', text: ctx.T('email') }), emailInput]),
        ]),
        el('label', { class: 'tf-label', text: S.notes }),
        notesInput,
        summary,
        errorMsg,
        submitBtn,
      ]);

      function showError(msg) {
        errorMsg.textContent = msg || '';
        errorMsg.hidden = !msg;
      }

      function submitLabel() {
        var s = service();
        return s && s.dueNowCents > 0 ? S.pay : S.book;
      }

      function renderSummary() {
        var s = service();
        if (!s || !state.time) {
          summary.hidden = true;
          return;
        }
        var line = s.name + ' · ' + ctx.formatDate(state.date) + ' · ' + state.time;
        if (s.priceCents > 0) line += ' · ' + ctx.money(s.priceCents);
        if (s.dueNowCents > 0) {
          line += ' — ' + fmt(s.dueNowCents >= s.priceCents ? S.dueNowFull : S.dueNow, {
            amount: ctx.money(s.dueNowCents),
          });
        }
        summary.textContent = line;
        summary.hidden = false;
      }

      function serviceButton(s, selected) {
        var children = [
          el('span', {}, [el('b', { text: s.name }), el('small', { text: serviceMeta(s) })]),
        ];
        if (s.priceCents > 0) children.push(el('span', { class: 'tfa-price', text: ctx.money(s.priceCents) }));
        var b = el(
          'button',
          { class: 'tfa-svc' + (selected ? ' tfa-on' : ''), type: 'button', 'aria-pressed': selected ? 'true' : 'false' },
          children
        );
        if (!selected) {
          b.addEventListener('click', function () {
            state.serviceId = s.id;
            onServiceChange();
          });
        }
        return b;
      }

      function renderServices() {
        servicesWrap.textContent = '';
        var chosen = service();
        if (chosen) {
          servicesWrap.appendChild(serviceButton(chosen, true));
          if (state.services.length > 1) {
            var change = el('button', { class: 'tfa-change', type: 'button', text: S.change });
            change.addEventListener('click', function () {
              state.serviceId = null;
              onServiceChange();
            });
            servicesWrap.appendChild(change);
          }
          return;
        }
        var lastCategory = null;
        state.services.forEach(function (s) {
          var category = s.category || '';
          if (category !== lastCategory) {
            if (category) servicesWrap.appendChild(el('p', { class: 'tfa-cat', text: category }));
            lastCategory = category;
          }
          servicesWrap.appendChild(serviceButton(s, false));
        });
      }

      function renderStaff() {
        staffSelect.textContent = '';
        var options = state.serviceId ? staffFor(state.serviceId) : [];
        if (state.staffId !== 'any' && !options.some(function (m) { return m.id === state.staffId; })) {
          state.staffId = 'any';
        }
        // "Any professional" only means something when there is a choice.
        if (options.length !== 1) staffSelect.appendChild(el('option', { value: 'any', text: S.anyPro }));
        options.forEach(function (m) {
          staffSelect.appendChild(
            el('option', { value: m.id, text: m.title ? m.name + ' · ' + m.title : m.name })
          );
        });
        if (options.length === 1) state.staffId = options[0].id;
        staffSelect.value = state.staffId;
      }

      function renderSlots() {
        slotsWrap.textContent = '';
        state.time = null;
        submitBtn.disabled = true;
        renderSummary();

        if (!state.date) {
          slotsMsg.textContent = S.pickDate;
          slotsMsg.hidden = false;
          return;
        }
        if (state.loading) {
          slotsMsg.hidden = true;
          for (var i = 0; i < 6; i++) {
            slotsWrap.appendChild(el('div', { class: 'tf-skel', 'aria-hidden': 'true' }));
          }
          slotsWrap.setAttribute('aria-busy', 'true');
          slotsWrap.setAttribute('aria-label', S.checking);
          return;
        }
        slotsWrap.removeAttribute('aria-busy');
        slotsWrap.removeAttribute('aria-label');

        if (!state.slots.length) {
          slotsMsg.textContent = S.none;
          slotsMsg.hidden = false;
          return;
        }
        slotsMsg.hidden = true;
        state.slots.forEach(function (slot) {
          var b = el('button', { class: 'tf-slot', type: 'button', text: slot.time });
          b.addEventListener('click', function () {
            state.time = slot.time;
            slotsWrap.querySelectorAll('.tf-slot').forEach(function (n) {
              n.classList.remove('tf-selected');
            });
            b.classList.add('tf-selected');
            submitBtn.disabled = false;
            renderSummary();
          });
          slotsWrap.appendChild(b);
        });
      }

      // keepError: reloading right after a failed booking must not wipe the
      // message that explains why.
      function loadAvailability(keepError) {
        if (!state.serviceId || !state.date) {
          state.slots = [];
          state.loading = false;
          renderSlots();
          return;
        }
        var request = ++state.request;
        state.loading = true;
        if (!keepError) showError(null);
        renderSlots();

        ctx.getJson(
          '/api/public/appointments/availability?restaurant=' + encodeURIComponent(ctx.businessId) +
            '&service=' + encodeURIComponent(state.serviceId) +
            '&staff=' + encodeURIComponent(state.staffId) +
            '&date=' + encodeURIComponent(state.date)
        ).then(function (res) {
          if (request !== state.request) return; // a newer choice superseded this one
          state.loading = false;
          if (!res.ok) {
            state.slots = [];
            showError(res.d.error || ctx.T('loadError'));
          } else {
            state.slots = res.d.slots || [];
          }
          renderSlots();
        });
      }

      function onServiceChange() {
        renderServices();
        rest.hidden = !state.serviceId;
        if (!state.serviceId) return;
        renderStaff();
        submitBtn.textContent = submitLabel();
        loadAvailability(false);
      }

      staffSelect.addEventListener('change', function () {
        state.staffId = staffSelect.value;
        loadAvailability(false);
      });
      dateInput.addEventListener('change', function () {
        state.date = dateInput.value;
        loadAvailability(false);
      });

      var form = el('form', {}, [el('label', { class: 'tf-label', text: S.service }), servicesWrap, rest]);
      root.textContent = '';
      root.appendChild(form);
      onServiceChange();

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var chosen = service();
        if (!chosen || !state.time) return;
        ctx.busy(submitBtn, S.booking);
        showError(null);

        ctx.postJson('/api/public/appointments', {
          restaurant: ctx.businessId,
          service: chosen.id,
          staff: state.staffId,
          date: state.date,
          time: state.time,
          name: nameInput.value.trim(),
          phone: phoneInput.value.trim(),
          email: emailInput.value.trim(),
          notes: notesInput.value.trim(),
          lang: ctx.lang,
        }).then(function (res) {
          if (!res.ok) {
            submitBtn.disabled = false;
            submitBtn.textContent = submitLabel();
            if (res.d.code === 'SLOT_TAKEN') {
              showError(S.taken);
              loadAvailability(true);
            } else {
              showError(res.d.error || ctx.T('genericError'));
            }
            return;
          }

          if (res.d.checkoutUrl) {
            root.textContent = '';
            root.appendChild(el('div', { class: 'tf-done' }, [el('p', { text: S.redirecting })]));
            window.location.href = res.d.checkoutUrl;
            return;
          }

          var a = res.d.appointment;
          var body = fmt(S.confirmedBody, {
            service: a.serviceName,
            date: ctx.formatDate(a.date, { weekday: 'long', month: 'long' }),
            time: a.time,
          });
          if (a.staffName) body += ' ' + fmt(S.withStaff, { staff: a.staffName });
          root.textContent = '';
          root.appendChild(
            el('div', { class: 'tf-done' }, [
              ctx.checkIcon(),
              el('h3', { text: S.confirmedTitle }),
              el('p', { text: body }),
              el('p', { text: S.emailNote }),
            ])
          );
        });
      });
    }
  }

  if (window.TableFrontWidget && typeof window.TableFrontWidget.register === 'function') {
    window.TableFrontWidget.register('appointments', render);
  }
})();
