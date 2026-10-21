// Runs before every integration test file. Resolves the STAGING target from
// TEST_SUPABASE_* (refusing production) and exposes it to the app code under
// test through the variables the app actually reads.
import { resolveTestSupabase, refFromSupabaseUrl, productionRefs } from '../helpers/staging';

const target = resolveTestSupabase({ needServiceRole: true });

process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = target.anonKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceRoleKey;
// Never let real email go out from a test run; failures are logged, never thrown.
process.env.RESEND_API_KEY = 're_test_dummy_key';
process.env.EMAIL_FROM = 'TableFront Tests <onboarding@resend.dev>';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3100';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'integration-test-admin-secret';

// Final paranoia: whatever the app will read must not be production.
const effectiveRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
if (!effectiveRef || productionRefs().includes(effectiveRef)) {
  throw new Error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL resolved to ${effectiveRef ?? 'an invalid URL'}.`);
}
