import { z } from 'zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('127.0.0.1'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DB_PATH: z.string().default('data/gtm.db'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  YOUTUBE_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  MODEL_FAST: z.string().default('claude-haiku-5-5'),
  MODEL_WRITER: z.string().default('claude-opus-5-5'),

  SENDER_NAME: z.string().default('Percy'),
  SENDER_TITLE: z.string().default('Founder, Loorio'),
  SENDER_ADDRESS: z.string().default(''),

  NICHES: csv('SAT prep tips,study tips college,college life advice,learn something new shorts'),
  MIN_SUBSCRIBERS: z.coerce.number().int().default(5_000),
  MAX_SUBSCRIBERS: z.coerce.number().int().default(1_000_000),
  MIN_FIT_SCORE: z.coerce.number().int().min(0).max(100).default(60),
  ENRICH_PER_DAY: z.coerce.number().int().default(100),

  DAILY_SEND_LIMIT: z.coerce.number().int().default(50),
  SEND_WINDOW_START: z.coerce.number().int().min(0).max(23).default(9),
  SEND_WINDOW_END: z.coerce.number().int().min(1).max(24).default(17),
  FOLLOW_UP_DAYS: csv('3,7,14'),
  AUTO_APPROVE: bool,

  INBOX_POLL_SECONDS: z.coerce.number().int().min(15).default(60),
  NOTIFY_LEVEL: z.enum(['all', 'important']).default('all'),
  NTFY_TOPIC: z.string().default(''),
  NTFY_SERVER: z.string().url().default('https://ntfy.sh'),
  NOTIFY_DESKTOP: bool,
});

export type Config = z.infer<typeof ConfigSchema> & { followUpDays: number[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const followUpDays = parsed.data.FOLLOW_UP_DAYS.map(Number);
  if (followUpDays.some((d) => !Number.isInteger(d) || d < 1)) {
    throw new Error('FOLLOW_UP_DAYS must be a comma list of positive whole days, e.g. 3,7,14');
  }
  return { ...parsed.data, followUpDays };
}

/** Which integrations are configured — the worker skips jobs whose credentials are missing. */
export function capabilities(config: Config) {
  return {
    gmail: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    youtube: Boolean(config.YOUTUBE_API_KEY),
    ai: Boolean(config.ANTHROPIC_API_KEY),
    push: Boolean(config.NTFY_TOPIC),
  };
}
