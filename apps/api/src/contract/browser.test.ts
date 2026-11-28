import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configureZodForBrowser, runsInBrowser, sessionResponseSchema } from './index';

describe('runsInBrowser', () => {
  it('is true where a DOM exists, as in the web app', () => {
    expect(runsInBrowser({ window: {}, document: {} })).toBe(true);
  });

  it('is false in Node, where the api imports the contract', () => {
    expect(runsInBrowser()).toBe(false);
    expect(runsInBrowser({})).toBe(false);
    expect(runsInBrowser({ window: {} })).toBe(false);
    expect(runsInBrowser({ document: {} })).toBe(false);
  });
});

describe('configureZodForBrowser', () => {
  it('leaves zod with JIT when the contract is only imported, as the api does', () => {
    expect(z.config().jitless).not.toBe(true);
  });

  it('turns on jitless mode, so zod never probes eval under the CSP', () => {
    configureZodForBrowser();
    expect(z.config().jitless).toBe(true);
    // Calling it again changes nothing.
    configureZodForBrowser();
    expect(z.config().jitless).toBe(true);
  });

  it('still parses and refuses as before in jitless mode', () => {
    configureZodForBrowser();
    const session = { setupRequired: true, user: null, csrfToken: null };
    // Defaults fill the sec-auth and sec-mfa fields in jitless mode too.
    expect(sessionResponseSchema.parse(session)).toEqual({
      ...session,
      locked: false,
      mustChangePassword: false,
      signInNotice: null,
      mfa: 'none',
    });
    expect(sessionResponseSchema.safeParse({ setupRequired: 'yes' }).success).toBe(false);
    expect(sessionResponseSchema.safeParse({ ...session, locked: 'yes' }).success).toBe(false);
    expect(sessionResponseSchema.safeParse({ ...session, mfa: 'pending' }).success).toBe(false);
  });
});
