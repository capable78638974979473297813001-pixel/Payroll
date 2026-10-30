import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * What the page may load. Everything is from this origin except Stripe (Payment Element) and Google Fonts. Inline
 * styles are allowed because the dashboard's look is set from the company's own theme at run time.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.stripe.com",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** The file inside `root` for a URL path, or null. Refuses traversal, dotfiles, NUL bytes and anything outside root. */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '..' || p.startsWith('.'))) return null;
  const base = resolve(root);
  const target = resolve(join(base, normalize(parts.join('/'))));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/**
 * Serve a file from `root`, or the single-page app's index for any path without an extension (the router handles
 * it). Returns false when it did not answer, so the caller can 404.
 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const target = resolveInside(root, pathname === '/' ? '/index.html' : pathname);
  if (!target) return false;
  let file = target;
  let st = safeStat(file);
  if (!st || !st.isFile()) {
    // A path with an extension that is not there is a 404; a path without one is a page of the app.
    if (extname(pathname) !== '') return false;
    file = join(resolve(root), 'index.html');
    st = safeStat(file);
    if (!st || !st.isFile()) return false;
  }
  const ext = extname(file).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = { 'content-type': type, etag, 'cache-control': 'no-cache', ...SECURITY_HEADERS };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': String(st.size) });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
