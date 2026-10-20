# TableFront Reservations

Commission-free, multi-tenant SaaS reservation platform for independent restaurants (an alternative to TheFork / OpenTable).

## Locked V1 decisions (do not change without asking)
- Guests book without accounts: name, phone, email, date/time, party size, notes.
- Owner dashboard is shared at app.tablesfront.com, scoped per tenant.
- Embeddable widget is a JS snippet (NOT an iframe) that inherits CSS custom properties from the host site.
- Notifications are email only, via Resend.
- Database: Supabase (Postgres + Row Level Security). Hosting: Vercel. Manual admin onboarding until Day 5 of the sprint.
- Capacity: online booking cap per time slot, editable by the owner, with manual override.

## Out of scope (V2)
Floor plans, guest accounts, SMS, table payments, analytics.

## Rules
- Languages: EN, DE, PT (pt-PT, never Brazilian), FR.
- Brand: espresso #1A1208, cream #F5EFE0, brass gold #C9954A, terracotta #B85C38. Fonts: Playfair Display, Lora, Syne.
- Never run tests or migrations against the production Supabase project. Use tablefront-reservations-staging.
- Stripe: test mode only until told otherwise.
- Every behaviour change needs a test. Save migrations in /supabase/migrations.
- Commit after each passing step with a clear message. Do not merge to main.
- If a requirement is ambiguous, ask one question before building.
- Be blunt in reviews. Say what is wrong, with file and line.

@AGENTS.md
