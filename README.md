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
