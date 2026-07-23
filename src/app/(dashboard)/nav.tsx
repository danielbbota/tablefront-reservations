'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, ClipboardList, Plus, Settings } from 'lucide-react';

const ICONS = {
  '/day': CalendarDays,
  '/': ClipboardList,
  '/bookings/new': Plus,
  '/settings': Settings,
} as const;

export type NavItem = { href: keyof typeof ICONS; label: string };

/** Primary nav with icon + label and a visible active state. */
export default function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {items.map(({ href, label }) => {
        const Icon = ICONS[href];
        const active =
          href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              active
                ? 'bg-espresso text-cream shadow-card'
                : 'text-espresso/65 hover:bg-sand hover:text-espresso'
            }`}
          >
            <Icon size={16} strokeWidth={2} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
