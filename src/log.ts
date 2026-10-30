type Level = 'info' | 'warn' | 'error';

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const detail = extra instanceof Error ? ` — ${extra.message}` : extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  const out = level === 'info' ? process.stdout : process.stderr;
  out.write(`${line}${detail}\n`);
}

export interface Logger {
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
