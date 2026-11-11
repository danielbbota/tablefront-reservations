import { LogOut } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { logout } from '@/app/actions';
import { asLang, getT } from '@/lib/i18n';
import { businessTypeOf, type Restaurant } from '@/lib/types';
import Nav, { type NavItem } from './nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  // select('*') on purpose: it keeps working whether or not migration 0006
  // (business_type) has been applied yet.
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('*')
    .single<Restaurant>();
  const t = getT(asLang(restaurant?.language));
  const type = businessTypeOf(restaurant);

  const items: NavItem[] =
    type === 'stays'
      ? [
          { href: '/stays', label: t('nav.stays.calendar'), icon: 'calendar', exact: true },
          { href: '/stays/reservations', label: t('nav.stays.reservations'), icon: 'list' },
          { href: '/stays/new', label: t('nav.stays.new'), icon: 'plus' },
          { href: '/stays/units', label: t('nav.stays.units'), icon: 'units' },
          { href: '/settings', label: t('nav.settings'), icon: 'settings' },
        ]
      : type === 'appointments'
        ? [
            { href: '/agenda', label: t('nav.agenda'), icon: 'calendar', exact: true },
            { href: '/agenda/list', label: t('nav.appts.list'), icon: 'list' },
            { href: '/agenda/new', label: t('nav.appts.new'), icon: 'plus' },
            { href: '/services', label: t('nav.services'), icon: 'services' },
            { href: '/team', label: t('nav.team'), icon: 'team' },
            { href: '/settings', label: t('nav.settings'), icon: 'settings' },
          ]
        : [
            { href: '/day', label: t('nav.day'), icon: 'day' },
            { href: '/', label: t('nav.bookings'), icon: 'list' },
            { href: '/bookings/new', label: t('nav.add'), icon: 'plus' },
            { href: '/floor-plan', label: t('nav.floor'), icon: 'map' },
            { href: '/settings', label: t('nav.settings'), icon: 'settings' },
          ];
  const name = restaurant?.name ?? 'TableFront';

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-linen/80 bg-cream/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-espresso font-serif text-sm font-semibold text-cream shadow-card"
            >
              {name.slice(0, 1).toUpperCase()}
            </span>
            <div className="leading-tight">
              <span className="block font-serif text-base font-semibold tracking-tight text-espresso">
                {name}
              </span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-caramel">
                TableFront
              </span>
            </div>
          </div>

          <Nav items={items} />

          <form action={logout}>
            <button className="flex min-h-11 items-center gap-2 rounded-full px-3 py-2 text-sm text-espresso/50 transition-colors hover:bg-sand hover:text-espresso">
              <LogOut size={15} aria-hidden />
              {t('nav.signout')}
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10">{children}</main>
      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-espresso/40">
        Powered by TableFront
      </footer>
    </div>
  );
}
