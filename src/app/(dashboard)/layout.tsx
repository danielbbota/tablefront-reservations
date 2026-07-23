import { LogOut } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { logout } from '@/app/actions';
import { asLang, getT } from '@/lib/i18n';
import type { Restaurant } from '@/lib/types';
import Nav from './nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('name, language')
    .single<Pick<Restaurant, 'name' | 'language'>>();
  const t = getT(asLang(restaurant?.language));
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

          <Nav
            items={[
              { href: '/day', label: t('nav.day') },
              { href: '/', label: t('nav.bookings') },
              { href: '/bookings/new', label: t('nav.add') },
              { href: '/settings', label: t('nav.settings') },
            ]}
          />

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
