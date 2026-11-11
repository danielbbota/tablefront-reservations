// `npm run dev:local` — the whole app on this machine with no Supabase
// project: an in-memory database with the real migrations and demo data
// (scripts/local/), and `next dev` wired to it. Never touches production or
// staging; every value below overrides .env.local for this process only.
//
//   http://localhost:3200          dashboard (logins: scripts/local/seed.mjs)
//   http://127.0.0.1:54321/demo    a "customer website" embedding the widget
import { spawn } from 'node:child_process';
import { startLocalSupabase } from './local/supabase.mjs';
import { DEMO_LOGINS, DEMO_PASSWORD, seedDemo } from './local/seed.mjs';

const APP_PORT = Number(process.env.PORT ?? 3200);
const DB_PORT = 54321;
const appUrl = `http://localhost:${APP_PORT}`;

let ids;
const backend = await startLocalSupabase({
  port: DB_PORT,
  seed: async (db) => {
    ids = await seedDemo(db);
  },
});

// A stand-in for a customer's own website: another origin, plain HTML, the
// two-line embed snippet. ?b=restaurant|stays|appointments picks the business.
backend.route(async (req, url, res) => {
  if (url.pathname !== '/demo') return false;
  const kind = ['restaurant', 'stays', 'appointments'].includes(url.searchParams.get('b'))
    ? url.searchParams.get('b')
    : 'stays';
  const lang = /^(en|pt|de|fr)$/.test(url.searchParams.get('lang') ?? '') ? url.searchParams.get('lang') : '';
  const links = ['restaurant', 'stays', 'appointments']
    .map((k) => `<a href="/demo?b=${k}"${k === kind ? ' aria-current="page"' : ''}>${k}</a>`)
    .join(' · ');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Widget demo — ${kind}</title>
  <style>
    body { font-family: Georgia, serif; background: #faf7f0; color: #222; margin: 0; }
    main { max-width: 34rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    nav { font: 13px/1.4 system-ui, sans-serif; margin-bottom: 1.5rem; }
    nav a { color: #8c4225; } nav a[aria-current] { font-weight: 700; text-decoration: none; }
    h1 { font-size: 1.6rem; margin: 0 0 .25rem; } p { margin: 0 0 1.5rem; color: #666; }
  </style>
</head>
<body>
  <main>
    <nav>${links}</nav>
    <h1>Reserve online</h1>
    <p>Página de exemplo de um site de cliente, com o widget TableFront embutido.</p>
    <div data-tablefront-widget data-restaurant="${ids[kind]}"${lang ? ` data-lang="${lang}"` : ''}></div>
    <script src="${appUrl}/widget.js" async></script>
  </main>
</body>
</html>`);
  return true;
});

console.log(`
  Local database ready at ${backend.url} (in memory, reseeded on every start)
  Dashboard:   ${appUrl}
  Widget demo: ${backend.url}/demo?b=stays   (also b=appointments, b=restaurant)
  Logins:      ${Object.values(DEMO_LOGINS).join(', ')}
  Password:    see DEMO_PASSWORD in scripts/local/seed.mjs (${DEMO_PASSWORD.length} characters)
`);

const next = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: backend.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: backend.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: backend.serviceRoleKey,
    NEXT_PUBLIC_APP_URL: appUrl,
    ADMIN_SECRET: 'local-admin-secret',
    CRON_SECRET: 'local-cron-secret',
    // Dummy key: email sends fail and are logged, never delivered.
    RESEND_API_KEY: 're_local_dummy_key',
    EMAIL_FROM: 'TableFront Local <onboarding@resend.dev>',
    // Online payment stays off locally unless you export a Stripe TEST key yourself.
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? '',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

const stop = () => {
  next.kill('SIGTERM');
  backend.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
next.on('exit', (code) => backend.close().finally(() => process.exit(code ?? 0)));
