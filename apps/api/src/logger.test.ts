import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from './contract';
import { REDACT_PATHS, createLogger } from './logger';
import { createHarness, type Harness } from './testing/harness';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type RequestLine = { msg?: string; req?: { headers?: Record<string, unknown> } };

describe('logger', () => {
  it('redacts x-csrf-token', async () => {
    const h = createHarness({ logLevel: 'info' });
    harnesses.push(h);
    const admin = await h.setupAdmin();
    const token = admin.csrfToken;
    expect(token).toEqual(expect.any(String));
    expect(token?.length).toBeGreaterThanOrEqual(16);

    // A write and a read on the session, both carrying the header the client always sends.
    const write = await admin.patch('/api/assessment', { type: 'c3pao' });
    expect(write.statusCode).toBe(200);
    const read = await admin.get('/api/session');
    expect(read.statusCode).toBe(200);
    // A refused write with a wrong token is logged too, and that value never shows either.
    const forged = 'f'.repeat(token?.length ?? 32);
    const refused = await admin.patch(
      '/api/assessment',
      { type: 'self' },
      {
        headers: { [CSRF_HEADER]: forged },
      },
    );
    expect(refused.statusCode).toBe(403);

    const incoming = (h.logs as RequestLine[]).filter((line) => line.msg === 'incoming request');
    const withHeader = incoming.filter((line) => line.req?.headers?.[CSRF_HEADER] !== undefined);
    // Setup is sent before the client has a token; every later request carries one.
    expect(withHeader.length).toBeGreaterThanOrEqual(3);
    for (const line of withHeader) expect(line.req?.headers?.[CSRF_HEADER]).toBe('[Redacted]');

    for (const line of h.logs) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(token);
      expect(text).not.toContain(forged);
    }
    expect(REDACT_PATHS).toContain('req.headers["x-csrf-token"]');
  });
});

describe('redaction paths', () => {
  /** A logger at `trace` whose lines land, parsed, in the returned list. */
  function captured() {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger('trace', {
      write(line: string) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    return { log, lines };
  }

  it('redacts secret keys one level deep', () => {
    const { log, lines } = captured();
    const secrets = {
      password: 'top-level-password-1',
      currentPassword: 'top-level-current-2',
      newPassword: 'top-level-new-3',
      csrfToken: 'top-level-csrf-4',
      token: 'top-level-token-5',
      code: 'totp-code-918273',
      recoveryCode: 'top-level-recovery-6',
      secret: 'top-level-secret-7',
    };
    const nested = {
      password: 'nested-password-1',
      currentPassword: 'nested-current-2',
      newPassword: 'nested-new-3',
      csrfToken: 'nested-csrf-4',
      token: 'nested-token-5',
      code: 'totp-code-372819',
      recoveryCode: 'nested-recovery-6',
      secret: 'nested-secret-7',
    };

    log.info(
      {
        password: secrets.password,
        body: { newPassword: nested.newPassword, code: nested.code, secret: nested.secret },
      },
      'direct',
    );
    log.trace({ ...secrets, body: nested, user: { ...nested } }, 'every key');

    expect(lines).toHaveLength(2);
    const [direct, every] = lines;
    expect(direct).toMatchObject({
      msg: 'direct',
      password: '[Redacted]',
      body: { newPassword: '[Redacted]', code: '[Redacted]', secret: '[Redacted]' },
    });
    const censored = Object.fromEntries(Object.keys(secrets).map((key) => [key, '[Redacted]']));
    expect(every).toMatchObject({ ...censored, body: censored, user: censored });

    const text = JSON.stringify(lines);
    for (const value of [...Object.values(secrets), ...Object.values(nested)]) {
      expect(text).not.toContain(value);
    }
    for (const key of Object.keys(secrets)) {
      expect(REDACT_PATHS).toContain(key);
      expect(REDACT_PATHS).toContain(`*.${key}`);
    }
  });

  it('leaves other keys alone and never touches the logged object', () => {
    const { log, lines } = captured();
    const body = { email: 'someone@example.com', password: 'a-password-value' };
    log.info({ body, passwordless: true }, 'kept');
    expect(lines[0]).toMatchObject({
      body: { email: 'someone@example.com', password: '[Redacted]' },
      passwordless: true,
    });
    // Redaction works on the serialized copy: the caller's object keeps its value.
    expect(body.password).toBe('a-password-value');
  });
});
