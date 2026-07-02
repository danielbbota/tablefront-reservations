import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase/server';
import { logout } from '@/app/actions';
import { asLang, getT } from '@/lib/i18n';
import type { Restaurant } from '@/lib/types';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('name, language')
    .single<Pick<Restaurant, 'name' | 'language'>>();
  const t = getT(asLang(restaurant?.language));

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-linen bg-white/70 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-y-2 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <span className="font-serif text-lg font-semibold tracking-tight text-espresso">
              {restaurant?.name ?? 'TableFront'}
            </span>
            <nav className="flex gap-5 text-sm font-medium text-espresso/70">
              <Link href="/" className="transition hover:text-terracotta">
                {t('nav.bookings')}
              </Link>
              <Link href="/bookings/new" className="transition hover:text-terracotta">
                {t('nav.add')}
              </Link>
              <Link href="/settings" className="transition hover:text-terracotta">
                {t('nav.settings')}
              </Link>
            </nav>
          </div>
          <form action={logout}>
            <button className="text-sm text-espresso/50 transition hover:text-espresso">
              {t('nav.signout')}
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-espresso/40">
        Powered by TableFront
      </footer>
    </div>
  );
}
