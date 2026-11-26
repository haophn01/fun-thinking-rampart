import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db/client';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { createHarness, type Harness } from '../testing/harness';
import { WebBuildMissingError } from './web-app';

const INDEX = '<!doctype html><title>Rampart</title><div id="root"></div>';
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Placed next to the dist folder (and in skipped files); no response may ever carry it. */
const SENTINEL = 'SENTINEL-outside-dist-7f3a';

const harnesses: Harness[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const made of harnesses.splice(0)) await made.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A temp folder holding `secret.txt` (the sentinel) and `dist/` with the given files. */
function makeBuild(files: Record<string, string | Buffer>): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), 'rampart-web-'));
  folders.push(root);
  writeFileSync(join(root, 'secret.txt'), SENTINEL);
  const dist = join(root, 'dist');
  mkdirSync(dist);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dist, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, dist };
}

function serving(dist: string, env: Record<string, string> = {}): Harness {
  const made = createHarness({ env: { SERVE_WEB: 'true', WEB_DIST_PATH: dist, ...env } });
  harnesses.push(made);
  return made;
}

function get(app: FastifyInstance, url: string, method: 'GET' | 'HEAD' | 'POST' = 'GET') {
  return app.inject({ method, url });
}

function expectJson404(response: LightMyRequestResponse, message?: string): void {
  expect(response.statusCode).toBe(404);
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  const body = response.json<{ error: { code: string; message: string } }>();
  expect(body.error.code).toBe('not_found');
  if (message !== undefined) expect(body.error.message).toBe(message);
}

function expectIndex(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.headers['cache-control']).toBe('no-cache');
  expect(response.body).toBe(INDEX);
}

/** Sends a request line exactly as written over a real socket, so nothing normalizes the path. */
async function rawGet(app: FastifyInstance, target: string): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

describe('registerWebApp', () => {
  it('serves built files with type and caching', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { dist } = makeBuild({
      'index.html': INDEX,
      'assets/index-abc123.js': 'console.log(1);',
      'assets/index-abc123.css': 'body{margin:0}',
      'assets/inter-x.woff2': 'woff2-bytes',
      'assets/inter-x.woff': 'woff-bytes',
      'assets/logo-x.png': png,
      'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'favicon.ico': 'ico-bytes',
      'robots.txt': 'User-agent: *',
      'data.json': '{"a":1}',
      'site.webmanifest': '{"name":"Rampart"}',
      'page.html': '<p>page</p>',
    });
    const { app } = serving(dist);

    const cases: [string, string, string | Buffer][] = [
      ['/assets/index-abc123.js', 'text/javascript; charset=utf-8', 'console.log(1);'],
      ['/assets/index-abc123.css', 'text/css; charset=utf-8', 'body{margin:0}'],
      ['/assets/inter-x.woff2', 'font/woff2', 'woff2-bytes'],
      ['/assets/inter-x.woff', 'font/woff', 'woff-bytes'],
      ['/assets/logo-x.png', 'image/png', png],
      ['/favicon.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['/favicon.ico', 'image/x-icon', 'ico-bytes'],
      ['/robots.txt', 'text/plain; charset=utf-8', 'User-agent: *'],
      ['/data.json', 'application/json', '{"a":1}'],
      ['/site.webmanifest', 'application/manifest+json', '{"name":"Rampart"}'],
      ['/page.html', 'text/html; charset=utf-8', '<p>page</p>'],
      ['/index.html', 'text/html; charset=utf-8', INDEX],
    ];
    for (const [url, type, content] of cases) {
      const response = await get(app, url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toBe(type);
      expect(response.rawPayload.equals(Buffer.from(content)), url).toBe(true);
      expect(response.headers['cache-control'], url).toBe(
        url.startsWith('/assets/') ? IMMUTABLE : 'no-cache',
      );
    }

    // The query string is ignored, and HEAD answers the same headers with no body.
    const queried = await get(app, '/assets/index-abc123.js?v=2');
    expect(queried.statusCode).toBe(200);
    expect(queried.body).toBe('console.log(1);');
    const head = await get(app, '/assets/index-abc123.css', 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(head.headers['cache-control']).toBe(IMMUTABLE);
    expect(head.body).toBe('');
  });

  it('SPA fallback for page paths', async () => {
    const { dist } = makeBuild({ 'index.html': INDEX, 'assets/a.js': 'a' });
    const { app } = serving(dist);

    for (const url of ['/', '/assessment', '/ssp?tab=export', '/poam/', '/apix', '/assets']) {
      expectIndex(await get(app, url));
    }
    // Deep links with params a router would read.
    expectIndex(await get(app, '/assessment?family=AC&req=AC.L2-3.1.20'));

    const head = await get(app, '/assessment', 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(head.headers['cache-control']).toBe('no-cache');
    expect(head.body).toBe('');

    // Other methods on page paths keep today's 404.
    expectJson404(await get(app, '/assessment', 'POST'), 'No route for POST /assessment');
  });

  it('missing assets and api paths stay JSON 404', async () => {
    const { dist } = makeBuild({ 'index.html': INDEX, 'assets/a.js': 'a' });
    const { app } = serving(dist);
    // The web app is on: the file next door is served, so the 404s below are its decisions.
    expect((await get(app, '/assets/a.js')).statusCode).toBe(200);

    expectJson404(await get(app, '/assets/x.js'), 'No route for GET /assets/x.js');
    expectJson404(await get(app, '/assets/x.js?v=1'), 'No route for GET /assets/x.js');
    expectJson404(await get(app, '/favicon.png'), 'No route for GET /favicon.png');
    expectJson404(await get(app, '/ssp/v1.2'), 'No route for GET /ssp/v1.2');
    expectJson404(await get(app, '/api/nope'), 'No route for GET /api/nope');
    expectJson404(await get(app, '/api/nope?x=1'), 'No route for GET /api/nope');
    expectJson404(await get(app, '/api'), 'No route for GET /api');
    expectJson404(await get(app, '/api/'), 'No route for GET /api/');
    expectJson404(await get(app, '/api/assessment/nope/deeper'));
    const head = await get(app, '/api/nope', 'HEAD');
    expect(head.statusCode).toBe(404);
    expect(head.headers['content-type']).toMatch(/^application\/json/);
    expect((await get(app, '/assets/x.js', 'HEAD')).statusCode).toBe(404);

    // The api routes still win over the web app.
    const health = await get(app, '/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', db: 'ok' });
    expect((await get(app, '/api/assessment')).statusCode).toBe(401);
  });

  it('no path escapes the dist folder', async () => {
    const { root, dist } = makeBuild({ 'index.html': INDEX, 'assets/a.js': 'a' });
    const sentinel = join(root, 'secret.txt');
    const posix = sentinel.replaceAll('\\', '/');
    const attempts = [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets%2f..%2f..%2fsecret.txt',
      '/..%2f..%2fsecret.txt',
      '/..\\secret.txt',
      '/assets\\..\\..\\secret.txt',
      '/%5c..%5csecret.txt',
      '/..%5c..%5csecret',
      '/%2e%2e',
      '/..',
      `/${posix}`,
      `/${encodeURIComponent(sentinel)}`,
      `//${posix.replace(/^\//, '')}`,
      '/assets/..%00/secret.txt',
    ];
    const { app } = serving(dist);
    // The web app is on, so each answer below is its decision, not a missing route.
    expectIndex(await get(app, '/'));
    expect((await get(app, '/assets/a.js')).body).toBe('a');
    for (const url of attempts) {
      const response = await get(app, url);
      expect(response.body, url).not.toContain(SENTINEL);
      // Either the SPA page or a JSON 404; never a file from outside.
      if (response.statusCode === 200) expect(response.body, url).toBe(INDEX);
      else expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
    }

    // The same request lines over a real socket, where no client tidies the path first.
    for (const target of attempts) {
      const fresh = serving(dist);
      const raw = await rawGet(fresh.app, target);
      expect(raw, target).toMatch(/^HTTP\/1\.1 \d{3}/);
      expect(raw, target).not.toContain(SENTINEL);
    }
  }, 30_000);

  it('manifest is fixed and allowlisted', async () => {
    const { root, dist } = makeBuild({
      'index.html': INDEX,
      '.env': SENTINEL,
      '.hidden/x.js': SENTINEL,
      'assets/.secret.js': SENTINEL,
      'assets/app.js.map': SENTINEL,
      'notes.md': SENTINEL,
      'server.ts': SENTINEL,
      'archive.zip': SENTINEL,
      'shout.JS': SENTINEL,
    });
    // A folder link (a junction on Windows, which needs no extra rights) pointing outside.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.js'), SENTINEL);
    symlinkSync(outside, join(dist, 'linked'), 'junction');
    // A file link needs extra rights on Windows; where it can't be made, CI's Linux covers it.
    let fileLink = true;
    try {
      symlinkSync(join(root, 'secret.txt'), join(dist, 'link.txt'), 'file');
    } catch {
      fileLink = false;
    }

    const { app } = serving(dist);
    // Added after the app was built: not in the manifest.
    writeFileSync(join(dist, 'late.js'), SENTINEL);
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'late.css'), SENTINEL);

    const skipped = [
      '/.env',
      '/.hidden/x.js',
      '/assets/.secret.js',
      '/assets/app.js.map',
      '/notes.md',
      '/server.ts',
      '/archive.zip',
      '/shout.JS',
      '/linked/leak.js',
      '/late.js',
      '/assets/late.css',
      ...(fileLink ? ['/link.txt'] : []),
    ];
    for (const url of skipped) {
      const response = await get(app, url);
      expect(response.body, url).not.toContain(SENTINEL);
      expectJson404(response);
    }
    // Any dot in the last segment reads as a file name, so a dot folder is a JSON 404 too.
    expectJson404(await get(app, '/.hidden'));
  });

  it('serve-web off and build missing', async () => {
    const { dist } = makeBuild({ 'assets/a.js': 'a' });
    const handle = openDb(':memory:');
    try {
      const build = (path: string) =>
        buildApp({
          config: loadConfig({ DATABASE_PATH: ':memory:', SERVE_WEB: 'true', WEB_DIST_PATH: path }),
          db: handle.db,
          logStream: { write: () => undefined },
        });
      for (const path of [dist, join(dist, 'no-such-folder')]) {
        let thrown: unknown;
        try {
          await build(path).close();
        } catch (error) {
          thrown = error;
        }
        expect(thrown, path).toBeInstanceOf(WebBuildMissingError);
        expect((thrown as Error).name).toBe('WebBuildMissingError');
        expect((thrown as Error).message).toBe(
          `SERVE_WEB=true but ${path}/index.html is missing. Run \`pnpm build\` first.`,
        );
      }
    } finally {
      handle.sqlite.close();
    }

    // Without SERVE_WEB nothing is served, even with a full build in place.
    const built = makeBuild({ 'index.html': INDEX, 'assets/a.js': 'a' });
    const off = createHarness({ env: { WEB_DIST_PATH: built.dist } });
    harnesses.push(off);
    expectJson404(await get(off.app, '/'), 'No route for GET /');
    expectJson404(await get(off.app, '/assessment'), 'No route for GET /assessment');
    expectJson404(await get(off.app, '/assets/a.js'), 'No route for GET /assets/a.js');
    const explicit = serving(built.dist, { SERVE_WEB: 'false' });
    expectJson404(await get(explicit.app, '/'), 'No route for GET /');
  });
});
