import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { BUSINESS_TYPES, type BusinessType, type OperatingHours } from '@/lib/types';

const DEFAULT_HOURS: OperatingHours = {
  '0': { open: '18:00', close: '22:00', closed: false },
  '1': { open: '18:00', close: '22:00', closed: true },
  '2': { open: '18:00', close: '22:00', closed: false },
  '3': { open: '18:00', close: '22:00', closed: false },
  '4': { open: '18:00', close: '22:00', closed: false },
  '5': { open: '18:00', close: '22:00', closed: false },
  '6': { open: '18:00', close: '22:00', closed: false },
};

/** Clinics, barbers and salons: daytime hours, closed on Sunday. */
const DEFAULT_APPOINTMENT_HOURS: OperatingHours = Object.fromEntries(
  ['0', '1', '2', '3', '4', '5', '6'].map((d) => [
    d,
    { open: '09:00', close: '19:00', closed: d === '0' },
  ])
);

/**
 * POST /api/admin/restaurants — admin-only (x-admin-secret header).
 * Creates the business (a restaurant unless `businessType` says "stays" or
 * "appointments"), the owner auth user + owners row, and returns the embed
 * snippet and login credentials.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get('x-admin-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const name = String(body.name ?? '').trim();
  const slug = String(body.slug ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const timezone = String(body.timezone ?? 'Europe/Lisbon').trim();
  const language = ['en', 'pt', 'de', 'fr'].includes(String(body.language))
    ? String(body.language)
    : 'en';
  const businessType: BusinessType = BUSINESS_TYPES.includes(body.businessType)
    ? body.businessType
    : 'restaurant';
  if (body.businessType !== undefined && body.businessType !== businessType) {
    return NextResponse.json(
      { error: `businessType must be one of: ${BUSINESS_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
  const slotInterval = Number(body.slotIntervalMinutes ?? 30);
  const defaultMaxCovers = Number(body.defaultMaxCovers ?? 20);
  const ownerEmail = String(body.ownerEmail ?? '').trim().toLowerCase();
  const ownerPassword = String(body.ownerPassword ?? '');

  if (!name || !slug) return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });
  if (!ownerEmail.includes('@')) return NextResponse.json({ error: 'Valid ownerEmail required' }, { status: 400 });
  if (ownerPassword.length < 8)
    return NextResponse.json({ error: 'ownerPassword must be at least 8 characters' }, { status: 400 });
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return NextResponse.json({ error: `Invalid IANA timezone: ${timezone}` }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: restaurant, error: restErr } = await supabase
    .from('restaurants')
    .insert({
      name,
      slug,
      timezone,
      language,
      slot_interval_minutes: slotInterval,
      default_max_covers: defaultMaxCovers,
      operating_hours:
        body.operatingHours ??
        (businessType === 'appointments' ? DEFAULT_APPOINTMENT_HOURS : DEFAULT_HOURS),
      // Only sent for the new products, so creating a restaurant keeps working
      // on a database that has not run migration 0006 yet.
      ...(businessType !== 'restaurant' ? { business_type: businessType } : {}),
    })
    .select()
    .single();

  if (restErr || !restaurant) {
    return NextResponse.json(
      { error: `Could not create restaurant: ${restErr?.message}` },
      { status: 400 }
    );
  }

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });

  if (authErr || !authUser.user) {
    // Roll back the restaurant so a failed run leaves nothing behind.
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    return NextResponse.json(
      { error: `Could not create owner user: ${authErr?.message}` },
      { status: 400 }
    );
  }

  const { error: ownerErr } = await supabase.from('owners').insert({
    id: authUser.user.id,
    restaurant_id: restaurant.id,
    email: ownerEmail,
  });

  if (ownerErr) {
    await supabase.auth.admin.deleteUser(authUser.user.id);
    await supabase.from('restaurants').delete().eq('id', restaurant.id);
    return NextResponse.json(
      { error: `Could not link owner: ${ownerErr.message}` },
      { status: 400 }
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
  const embedSnippet = [
    `<div data-tablefront-widget data-restaurant="${restaurant.id}"></div>`,
    `<script src="${appUrl}/widget.js" async></script>`,
  ].join('\n');

  return NextResponse.json(
    {
      restaurant: { id: restaurant.id, name, slug, businessType },
      owner: { email: ownerEmail },
      dashboardUrl: appUrl,
      embedSnippet,
    },
    { status: 201 }
  );
}
