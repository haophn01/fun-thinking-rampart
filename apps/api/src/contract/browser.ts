import { z } from 'zod';

/**
 * zod checks whether it may compile parsers by calling `Function('')`. Under the page CSP
 * (`script-src 'self'`, no `unsafe-eval`) the browser blocks that call and reports a
 * `securitypolicyviolation` on every page load. In jitless mode zod skips the check and parses
 * without compiling. zod makes that choice per schema when the schema is built, so it must be
 * set before any schema exists: a call in the web app's code would run too late, after its
 * imports have built every schema.
 */
export function configureZodForBrowser(): void {
  z.config({ jitless: true });
}

/** True where a DOM exists (the web app, and its jsdom tests); false in Node, where the api runs. */
export function runsInBrowser(scope: object = globalThis): boolean {
  return 'window' in scope && 'document' in scope;
}

// The contract's first module, so this runs before any contract schema is built. The api
// imports the contract in Node, so it keeps JIT.
if (runsInBrowser()) configureZodForBrowser();
