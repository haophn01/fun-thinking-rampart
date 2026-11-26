import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { SecuritySeam } from './context';

/** The only file types the web app serves, by extension (matched exactly, lower case). */
export const WEB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** Vite fingerprints everything under `/assets/`, so those never change at the same URL. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** `SERVE_WEB=true` with no built web app to serve. */
export class WebBuildMissingError extends Error {
  constructor(readonly distPath: string) {
    super(`SERVE_WEB=true but ${distPath}/index.html is missing. Run \`pnpm build\` first.`);
    this.name = 'WebBuildMissingError';
  }
}

export interface WebFile {
  contentType: string;
  cacheControl: string;
  body: Buffer;
}

/** URL path (`/assets/index-abc.js`) to file, fixed when the app is built. */
export type WebManifest = ReadonlyMap<string, WebFile>;

function contentTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return Object.hasOwn(WEB_CONTENT_TYPES, name.slice(dot))
    ? WEB_CONTENT_TYPES[name.slice(dot)]
    : undefined;
}

function collect(dir: string, urlPrefix: string, into: Map<string, WebFile>): void {
  for (const name of readdirSync(dir)) {
    // Dotfiles and dot folders (`.env`, `.git`) are never served.
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    // lstat, so a link (or a Windows junction) is skipped rather than followed out of the folder.
    const stat = lstatSync(full);
    const url = `${urlPrefix}/${name}`;
    if (stat.isDirectory()) {
      collect(full, url, into);
      continue;
    }
    if (!stat.isFile()) continue;
    const contentType = contentTypeOf(name);
    if (contentType === undefined) continue;
    into.set(url, {
      contentType,
      cacheControl: url.startsWith('/assets/') ? IMMUTABLE : NO_CACHE,
      body: readFileSync(full),
    });
  }
}

/**
 * Reads the built web app once. Regular files with a listed extension only; their bytes are kept,
 * so nothing on disk is touched per request and files added later are never served.
 */
export function readWebManifest(distPath: string): WebManifest {
  let isDir: boolean;
  try {
    isDir = lstatSync(distPath).isDirectory();
  } catch {
    isDir = false;
  }
  const manifest = new Map<string, WebFile>();
  if (isDir) collect(distPath, '', manifest);
  if (!manifest.has('/index.html')) throw new WebBuildMissingError(distPath);
  return manifest;
}

export type WebAnswer = { kind: 'file'; file: WebFile } | { kind: 'not_found'; path: string };

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** The last segment, split on both slashes, has a dot: an asset name, never a page path. */
function looksLikeFile(path: string): boolean {
  const last = path.split(/[/\\]/).at(-1) ?? '';
  return last.includes('.');
}

/**
 * What a GET or HEAD for `url` answers. The manifest is the only lookup, so no form of `..`,
 * encoded slash, backslash or absolute path can name a file outside the dist folder.
 */
export function resolveWebRequest(manifest: WebManifest, url: string): WebAnswer {
  const path = url.split('?')[0] ?? '';
  const decoded = decodePath(path);
  const file = decoded === null ? undefined : manifest.get(decoded);
  if (file !== undefined) return { kind: 'file', file };
  const checked = decoded ?? path;
  if (isApiPath(path) || isApiPath(checked) || looksLikeFile(path) || looksLikeFile(checked)) {
    return { kind: 'not_found', path };
  }
  const index = manifest.get('/index.html');
  if (index === undefined) return { kind: 'not_found', path };
  return { kind: 'file', file: index };
}

/**
 * With `config.serveWeb`, serves the built web app from `config.webDistPath`: manifest files, and
 * `index.html` for page paths (the SPA fallback). Registered on the root after the api routes, so
 * those always win. Without it no web route exists, as before.
 */
export const registerWebApp: SecuritySeam = (app, ctx) => {
  if (!ctx.config.serveWeb) return;
  const manifest = readWebManifest(ctx.config.webDistPath);
  // GET only: Fastify answers HEAD from it with the same headers and no body.
  app.get('/*', (request: FastifyRequest, reply: FastifyReply) => {
    const answer = resolveWebRequest(manifest, request.url);
    if (answer.kind === 'not_found') {
      throw new AppError('not_found', `No route for ${request.method} ${answer.path}`);
    }
    return reply
      .header('content-type', answer.file.contentType)
      .header('cache-control', answer.file.cacheControl)
      .send(answer.file.body);
  });
};
