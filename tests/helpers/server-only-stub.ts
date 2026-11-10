// Vitest stand-in for the `server-only` package: in Next.js it throws when a
// server module is imported from a client bundle; under Vitest everything runs
// in Node, so it is a no-op.
export {};
