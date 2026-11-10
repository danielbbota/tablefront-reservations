'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BedDouble,
  CalendarDays,
  CalendarRange,
  ClipboardList,
  Map,
  Plus,
  Scissors,
  Settings,
  Users,
} from 'lucide-react';

const ICONS = {
  day: CalendarDays,
  list: ClipboardList,
  plus: Plus,
  map: Map,
  settings: Settings,
  calendar: CalendarRange,
  units: BedDouble,
  services: Scissors,
  team: Users,
} as const;

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Active only on this exact path (for a section's index page). */
  exact?: boolean;
};

/** Primary nav with icon + label and a visible active state. */
export default function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {items.map(({ href, label, icon, exact }) => {
        const Icon = ICONS[icon];
        const active = href === '/' || exact ? pathname === href : pathname.startsWith(href);
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
