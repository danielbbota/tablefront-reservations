'use client';

import { useState } from 'react';

type CreateResult = {
  restaurant: { id: string; name: string; slug: string };
  owner: { email: string };
  dashboardUrl: string;
  embedSnippet: string;
};

const input =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none';

/**
 * Internal admin console — protected by the ADMIN_SECRET, which is sent as a
 * header with each request and never stored. Creates a restaurant + owner
 * login and shows the embed snippet to hand to the client.
 */
export default function AdminPage() {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);

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
        timezone: f.get('timezone'),
        slotIntervalMinutes: Number(f.get('slotInterval')),
        defaultMaxCovers: Number(f.get('defaultMaxCovers')),
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
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-lg font-semibold text-neutral-900">TableFront admin</h1>
      <p className="mt-1 text-sm text-neutral-500">Create a restaurant and its owner login.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        <div>
          <label className="block text-sm font-medium text-neutral-700">Admin secret</label>
          <input
            type="password"
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className={input}
          />
        </div>
        <hr className="border-neutral-100" />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700">Restaurant name</label>
            <input name="name" required className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700">Slug</label>
            <input name="slug" required placeholder="girassol-quarteira" className={input} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700">Timezone</label>
            <input name="timezone" defaultValue="Europe/Lisbon" className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700">Slot interval</label>
            <input name="slotInterval" type="number" defaultValue={30} min={15} max={120} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700">Max covers/slot</label>
            <input name="defaultMaxCovers" type="number" defaultValue={20} min={0} className={input} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700">Owner email</label>
            <input name="ownerEmail" type="email" required className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700">Owner password</label>
            <input name="ownerPassword" type="text" required minLength={8} className={input} />
          </div>
        </div>
        <button
          disabled={busy}
          className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create restaurant'}
        </button>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>

      {result && (
        <div className="mt-6 space-y-4 rounded-xl border border-green-200 bg-green-50 p-6 text-sm">
          <p className="font-medium text-green-900">
            Created “{result.restaurant.name}” ({result.restaurant.slug})
          </p>
          <div>
            <p className="text-green-900">
              Owner login: <strong>{result.owner.email}</strong> at{' '}
              <strong>{result.dashboardUrl}</strong> (password as entered above — share it
              securely, it is not stored here).
            </p>
          </div>
          <div>
            <p className="mb-2 font-medium text-green-900">Embed snippet:</p>
            <pre className="overflow-x-auto rounded-md bg-neutral-900 p-4 text-xs text-neutral-100">
              {result.embedSnippet}
            </pre>
          </div>
        </div>
      )}
    </main>
  );
}
