import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const LOG_PATH = resolve('.dexter/logs/pipeline.log');

function ensureLogDir(): void {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function logToFile(scope: string, message: string, data?: unknown): void {
  try {
    ensureLogDir();
    const entry = {
      ts: new Date().toISOString(),
      scope,
      message,
      data,
    };
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // Avoid throwing from logging paths.
  }
}
