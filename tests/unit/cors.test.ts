import { describe, expect, it } from 'vitest';
import { CORS_HEADERS, corsJson, corsPreflight } from '@/lib/cors';

describe('CORS helpers for the public widget API', () => {
  it('corsJson sets status, body and permissive CORS headers', async () => {
    const res = corsJson({ ok: true }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe(CORS_HEADERS['Access-Control-Allow-Methods']);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });
  it('corsJson defaults to 200', () => {
    expect(corsJson({}).status).toBe(200);
  });
  it('corsPreflight is an empty 204 with CORS headers', async () => {
    const res = corsPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(await res.text()).toBe('');
  });
});
