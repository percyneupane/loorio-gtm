import http from 'node:http';
import { assertLocalHost, assertSameOrigin, createRouter, HttpError, sendJson, serveStatic } from './http.ts';
import { errorMessage, logger } from './log.ts';
import { registerRoutes } from './routes.ts';
import type { Scheduler, Services } from './scheduler.ts';

const log = logger('http');

export function createServer(services: Services, scheduler: Scheduler, publicDir: string): http.Server {
  const router = createRouter();
  registerRoutes(router, services, scheduler);
  const appUrl = services.config.APP_URL;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', appUrl);
    try {
      assertLocalHost(req, appUrl);
      if (url.pathname.startsWith('/api/')) {
        assertSameOrigin(req, appUrl);
        const route = router.match(req.method ?? 'GET', url.pathname);
        if (!route) throw new HttpError(404, 'Not found');
        await route.handler({ req, res, url, params: route.params });
        return;
      }
      if (!serveStatic(res, publicDir, url.pathname)) sendJson(res, 404, { success: false, error: 'Not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error(`${req.method} ${url.pathname}`, error);
      const message = status === 500 ? `Server error: ${errorMessage(error)}` : errorMessage(error);
      if (!res.headersSent) sendJson(res, status, { success: false, error: message });
    }
  });
}
