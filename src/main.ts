import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from './ai/agent.ts';
import { capabilities, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { fetchPage } from './discovery/fetch-page.ts';
import { createGmail } from './google/gmail.ts';
import { createGoogleAuth } from './google/oauth.ts';
import { createYoutube } from './google/youtube.ts';
import { logger } from './log.ts';
import { createNotifier } from './notify.ts';
import { createServer } from './server.ts';
import { createScheduler, type Services } from './scheduler.ts';

const log = logger('main');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function main(): void {
  const config = loadConfig();
  const caps = capabilities(config);
  const db = openDb(config.DB_PATH);
  const auth = createGoogleAuth(db, config);

  const services: Services = {
    db,
    config,
    auth,
    gmail: createGmail(auth),
    youtube: caps.youtube ? createYoutube(config.YOUTUBE_API_KEY) : undefined,
    agent: caps.ai ? createAgent(config) : undefined,
    notify: createNotifier(config),
    fetchPage,
  };
  for (const [name, on] of Object.entries(caps)) if (!on) log.warn(`${name} is not configured — see .env.example`);

  const scheduler = createScheduler(services);

  const server = createServer(services, scheduler, PUBLIC_DIR);

  server.listen(config.PORT, config.HOST, () => {
    log.info(`dashboard on ${config.APP_URL} (listening ${config.HOST}:${config.PORT})`);
    scheduler.start();
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
