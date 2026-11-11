'use client';

import { useState } from 'react';

type Product = 'restaurant' | 'stays' | 'appointments';

type CreateResult = {
  restaurant: { id: string; name: string; slug: string };
  owner: { email: string };
  dashboardUrl: string;
  embedSnippet: string;
};

const input =
  'mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30';
const label = 'block text-sm font-medium text-espresso';

/**
 * Internal admin console — protected by the ADMIN_SECRET, which is sent as a
 * header with each request and never stored. Creates a business (restaurant,
 * stays or appointments) + owner login and shows the embed snippet to hand
 * to the client.
 */
export default function AdminPage() {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [product, setProduct] = useState<Product>('restaurant');
  // Time slots exist for tables and appointments, not for nights; a cover cap
  // per slot only exists for tables.
  const hasSlots = product !== 'stays';
  const hasCovers = product === 'restaurant';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    const f = new FormData(e.currentTarget);
    const res = await fetch('/api/admin/restaurants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({
        name: f.get('name'),
        slug: f.get('slug'),
        businessType: product,
        timezone: f.get('timezone'),
        language: f.get('language'),
        // Left out when the product has no such setting, so the API applies
        // its own defaults instead of receiving a 0 from a missing field.
        ...(hasSlots ? { slotIntervalMinutes: Number(f.get('slotInterval')) } : {}),
        ...(hasCovers ? { defaultMaxCovers: Number(f.get('defaultMaxCovers')) } : {}),
        ownerEmail: f.get('ownerEmail'),
        ownerPassword: f.get('ownerPassword'),
      }),
    });

    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? 'Request failed');
    else setResult(data);
  }

  return (
    <main className="min-h-screen bg-cream">
      <div className="tf-rise mx-auto max-w-xl px-4 py-12">
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-espresso">
          TableFront admin
        </h1>
        <p className="mt-1.5 text-sm text-espresso/60">
          Create a business and its owner login.
        </p>

        <form
          onSubmit={onSubmit}
          className="mt-6 space-y-4 rounded-2xl border border-linen bg-white p-6 shadow-card"
        >
          <div>
            <label className={label}>Admin secret</label>
            <input
              type="password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={input}
            />
          </div>
          <hr className="border-linen/60" />
          <div>
            <label className={label}>Product</label>
            <select
              name="businessType"
              value={product}
              onChange={(e) => setProduct(e.target.value as Product)}
              className={input}
            >
              <option value="restaurant">Restaurant / bar — table reservations</option>
              <option value="stays">Stays — hotel, guesthouse, Airbnb</option>
              <option value="appointments">Appointments — clinic, barber, salon</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Business name</label>
              <input name="name" required className={input} />
            </div>
            <div>
              <label className={label}>Slug</label>
              <input name="slug" required placeholder="girassol-quarteira" className={input} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Timezone</label>
              <input name="timezone" defaultValue="Europe/Lisbon" className={input} />
            </div>
            <div>
              <label className={label}>Language</label>
              <select name="language" defaultValue="en" className={input}>
                <option value="en">English</option>
                <option value="pt">Português</option>
                <option value="de">Deutsch</option>
                <option value="fr">Français</option>
              </select>
            </div>
          </div>
          {hasSlots && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>Slot interval (min)</label>
                <input name="slotInterval" type="number" defaultValue={30} min={15} max={120} className={input} />
              </div>
              {hasCovers && (
                <div>
                  <label className={label}>Max covers/slot</label>
                  <input name="defaultMaxCovers" type="number" defaultValue={20} min={0} className={input} />
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Owner email</label>
              <input name="ownerEmail" type="email" required className={input} />
            </div>
            <div>
              <label className={label}>Owner password</label>
              <input name="ownerPassword" type="text" required minLength={8} className={input} />
            </div>
          </div>
          <button
            disabled={busy}
            className="min-h-11 w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta active:scale-[0.99] disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create business'}
          </button>
          {error && (
            <p className="rounded-lg bg-wine/10 px-3 py-2.5 text-sm text-wine">{error}</p>
          )}
        </form>

        {result && (
          <div className="mt-6 space-y-4 rounded-2xl border border-leaf/30 bg-leaf/10 p-6 text-sm text-espresso">
            <p className="font-semibold">
              Created “{result.restaurant.name}” ({result.restaurant.slug})
            </p>
            <p>
              Owner login: <strong>{result.owner.email}</strong> at{' '}
              <strong>{result.dashboardUrl}</strong> (password as entered above — share it
              securely, it is not stored here).
            </p>
            <div>
              <p className="mb-2 font-semibold">Embed snippet:</p>
              <pre className="overflow-x-auto rounded-lg bg-espresso p-4 text-xs leading-relaxed text-cream">
                {result.embedSnippet}
              </pre>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
