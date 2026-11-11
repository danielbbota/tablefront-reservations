# TableFront Reservations

Commission-free, multi-tenant table reservation platform. One Next.js app serves:

- **Owner dashboard** (`app.tablesfront.com`) — bookings list, manual bookings,
  capacity + operating-hours settings, embed snippet. Email + password login
  (Supabase Auth); every query runs under Row Level Security so an owner can only
  ever touch their own restaurant's rows.
- **Guest booking widget** (`/widget.js`) — vanilla-JS, Shadow-DOM embed for client
  restaurant sites. No guest accounts. Themeable via CSS custom properties
  (`--tf-accent`, `--tf-font`, `--tf-radius`).
- **Public widget API** (`/api/public/*`) — availability + booking creation, CORS-open,
  served with the service-role key server-side (anon has zero direct table access).
- **Admin API + console** (`/admin`) — create a restaurant + owner credentials and get
  the embed snippet. Protected by the `ADMIN_SECRET` env var.

## Setup

1. **Env vars** — copy `.env.example` to `.env.local` and fill in the Supabase values
   (Project Settings → API), the Resend key, and an `ADMIN_SECRET`. Set the same
   variables in Vercel → Project Settings → Environment Variables for production,
   with `NEXT_PUBLIC_APP_URL` set to the deployed URL.
2. **Database** — run `supabase/migrations/0001_init.sql` in the Supabase SQL editor
   (or `supabase db push`). It creates the tables, RLS policies, and the atomic
   `create_widget_booking` function.
3. **Run** — `npm run dev`, then open `http://localhost:3000/admin` to create your
   first restaurant. Log in at `/` with the owner credentials it returns.

## Embedding the widget

```html
<div data-tablefront-widget data-restaurant="RESTAURANT_ID"></div>
<script src="https://app.tablesfront.com/widget.js" async></script>
```

Theme it from the host page (custom properties inherit into the shadow root):

```css
#booking-section { --tf-accent: #b4532a; --tf-font: 'Fraunces', serif; --tf-radius: 6px; }
```

## Capacity model

- Cap = **max covers (total guests) per time slot**, for **online** bookings only.
- Resolution: date+slot override → date override → day-of-week+slot → day-of-week →
  restaurant default. V1 UI edits the default and per-day-of-week overrides; the
  schema already supports the rest.
- All confirmed covers (widget **and** manual) count against the cap, but manual
  bookings created from the dashboard are never blocked by it.
- Concurrent widget bookings are serialized per slot with a Postgres advisory lock,
  so the last covers of a slot can't be double-sold.

## Email

Transactional email via Resend: guest confirmation + owner notification on new
widget bookings, guest cancellation email when a booking is cancelled from the
dashboard. Email failures are logged and never fail the booking itself.

## Three products, one platform

Every business (the `restaurants` table is the tenant table for all of them) has a
`business_type`, chosen when it is created in `/admin`. The same login, dashboard
shell, embed snippet, cancel links and emails serve all three; what the owner and
the guest see depends on the type.

| `business_type` | For | Owner dashboard | Guest widget |
|---|---|---|---|
| `restaurant` (default) | restaurants, bars | Day view, bookings, floor plan | date → time → party |
| `stays` | hotels, guesthouses, holiday rentals | `/stays` calendar per unit, reservations, units + seasonal prices, channels | dates + guests → unit with price |
| `appointments` | clinics, barbers, salons | `/agenda` day calendar per professional, appointments, services, team | service → professional → date → time |

Schema: `supabase/migrations/0006_verticals.sql`. It is additive: every existing
row becomes a `restaurant` and nothing changes for it. The app also keeps working
for restaurants on a database that has not run 0006 yet.

### Stays: Airbnb / Booking.com / Vrbo

TableFront is the calendar of record. Per unit (Units → a unit → channels):

1. **Import**: paste the channel's iCal export link. Its reservations are pulled
   into `stay_reservations` (source `airbnb` / `booking` / …) and block the dates.
2. **Export**: copy the unit's TableFront link into the channel's "import
   calendar". Use the per-channel link (`?for=airbnb`): it leaves out that
   channel's own reservations.

Channel calendars are re-read when an owner opens the calendar (if older than 15
minutes), synchronously right before a direct booking is confirmed (if older than
10), on "Sync now", and once a day by the reminders cron. Limits that come with
iCal, not with this code: feeds carry dates only (no guest name, email or price;
Airbnb adds the reservation code and the last 4 phone digits), and the channels
re-read *our* feed every few hours, not instantly. Overlapping reservations on a
unit are flagged on the calendar instead of hidden.

### Online payment (stays and appointments)

Per business, in Settings: no online payment (default), a percentage deposit, or
the full amount. Payments are Stripe Checkout **direct charges on the business's
own connected Stripe account** (no platform fee). A paid booking is first a
`pending_payment` hold (35 minutes); the Stripe webhook, or the `/pay/<token>`
return page, flips it to `confirmed` and only then sends the emails. Holds that
are never paid stop blocking by themselves. Refunds are done by the business in
Stripe. If Stripe is not configured, or the business has not finished connecting,
bookings are simply confirmed without payment.

Setup: `STRIPE_SECRET_KEY` (test key; live keys are ignored by design for now),
Connect enabled, and a Connect webhook to `/api/stripe/webhook` for
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.expired` and `account.updated`, with its signing secret in
`STRIPE_WEBHOOK_SECRET`.

## Running it locally without Supabase

```bash
npm run dev:local
```

Starts an in-memory Postgres with every migration applied and demo data for the
three products, a small Supabase-compatible API in front of it
(`scripts/local/supabase.mjs`: the PostgREST and Auth subset this app uses, with
real RLS), and `next dev` on <http://localhost:3200> wired to it. It never reads
`.env.local`'s project. Logins and the demo password are in
`scripts/local/seed.mjs`; <http://127.0.0.1:54321/demo?b=stays> (or
`b=appointments`, `b=restaurant`) is a stand-in customer site with the widget
embedded.
