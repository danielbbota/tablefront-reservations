/**
 * Order services for display: each category stays together, categories appear
 * in the order of their first service, and services keep their own order
 * inside a category. Without this a list sorted only by the owner's ordering
 * can show the same category heading twice.
 */
export function groupByCategory<T extends { category: string | null }>(services: T[]): T[] {
  const rank = new Map<string, number>();
  for (const s of services) {
    const key = s.category ?? '';
    if (!rank.has(key)) rank.set(key, rank.size);
  }
  // Array.prototype.sort is stable: equal categories keep their input order.
  return [...services].sort((a, b) => rank.get(a.category ?? '')! - rank.get(b.category ?? '')!);
}
