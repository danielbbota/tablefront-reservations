import Link from 'next/link';
import { createServerSupabase } from '@/lib/supabase/server';
import { logout } from '@/app/actions';
import type { Restaurant } from '@/lib/types';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabase();
  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('name')
    .single<Pick<Restaurant, 'name'>>();

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold text-neutral-900">
              {restaurant?.name ?? 'TableFront'}
            </span>
            <nav className="flex gap-4 text-sm text-neutral-600">
              <Link href="/" className="hover:text-neutral-900">
                Bookings
              </Link>
              <Link href="/bookings/new" className="hover:text-neutral-900">
                Add booking
              </Link>
              <Link href="/settings" className="hover:text-neutral-900">
                Settings
              </Link>
            </nav>
          </div>
          <form action={logout}>
            <button className="text-sm text-neutral-500 hover:text-neutral-900">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
