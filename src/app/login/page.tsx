import { login } from '@/app/actions';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="w-full max-w-sm rounded-2xl border border-linen bg-white p-8 shadow-sm">
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-espresso">
          TableFront
        </h1>
        <p className="mt-1.5 text-sm text-espresso/60">
          Sign in to your restaurant dashboard
        </p>

        {error && (
          <p className="mt-4 rounded-lg bg-wine/10 px-3 py-2.5 text-sm text-wine">{error}</p>
        )}

        <form action={login} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-espresso">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-espresso">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border border-linen bg-white px-3 py-2.5 text-sm text-espresso focus:border-caramel focus:outline-none focus:ring-2 focus:ring-caramel/30"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-espresso px-4 py-2.5 text-sm font-semibold text-cream transition hover:bg-terracotta"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
