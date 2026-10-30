import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { z } from 'zod';

/** Tiny router + helpers over node:http — the dashboard has a handful of JSON endpoints. */

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const MAX_BODY_BYTES = 256 * 1024;

export function createRouter() {
  const routes: Route[] = [];
  function add(method: string, pathPattern: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${pathPattern.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, pattern, keys, handler });
  }
  function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.pattern);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return undefined;
  }
  return {
    get: (p: string, h: Handler) => add('GET', p, h),
    post: (p: string, h: Handler) => add('POST', p, h),
    put: (p: string, h: Handler) => add('PUT', p, h),
    match,
  };
}

export type Router = ReturnType<typeof createRouter>;

export function sendJson<T>(res: ServerResponse, status: number, body: ApiResponse<T>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function ok<T>(ctx: Ctx, data: T): void {
  sendJson(ctx.res, 200, { success: true, data });
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

export async function readJson<S extends z.ZodType>(ctx: Ctx, schema: S): Promise<z.infer<S>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown = {};
  if (size > 0) {
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Body must be valid JSON');
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

export function intParam(ctx: Ctx, key: string): number {
  const n = Number(ctx.params[key]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${key}`);
  return n;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

/**
 * The dashboard runs on localhost, so a malicious web page could still try to POST to it.
 * Requiring JSON (which forces a CORS preflight cross-site) and a same-origin Origin header
 * blocks that.
 */
export function assertSameOrigin(req: IncomingMessage, appUrl: string): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin && origin !== new URL(appUrl).origin) throw new HttpError(403, 'Cross-origin request blocked');
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'Requests must be application/json');
  }
}

/**
 * Rejects requests whose Host header isn't this server — a DNS-rebinding page would otherwise be
 * able to read inbox and creator data through the victim's browser.
 */
export function assertLocalHost(req: IncomingMessage, appUrl: string): void {
  const port = req.socket.localPort;
  const allowed = new Set([new URL(appUrl).host, `localhost:${port}`, `127.0.0.1:${port}`]);
  if (!allowed.has(req.headers.host ?? '')) throw new HttpError(421, 'Unexpected Host header');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function serveStatic(res: ServerResponse, publicDir: string, pathname: string): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(path.resolve(publicDir) + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
