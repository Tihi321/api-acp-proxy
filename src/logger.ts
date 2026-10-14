import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry { time: string; level: LogLevel; scope: string; message: string; }
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: string): Logger;
  recent(limit?: number): LogEntry[];
  subscribe(listener: (entry: LogEntry) => void): () => void;
}
export interface LoggerOptions { console?: boolean; consoleLevel?: LogLevel; file?: string; maxFileBytes?: number; maxFiles?: number; ringSize?: number; }

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function rotate(file: string, maxFiles: number): void {
  try {
    for (let index = maxFiles - 1; index >= 1; index--) {
      const from = index === 1 ? file : `${file}.${index - 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index}`);
    }
  } catch { /* logging must never throw */ }
}

/** Console sink, optional size-rotating file sink (default 5 MB x 3) and an in-memory ring buffer for the UI. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { console: toConsole = true, consoleLevel = "info", file, maxFileBytes = 5 * 1024 * 1024, maxFiles = 3, ringSize = 500 } = options;
  const ring: LogEntry[] = [];
  const listeners = new Set<(entry: LogEntry) => void>();
  let fileSize = 0;
  if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fileSize = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { /* ignore */ } }

  const emit = (level: LogLevel, scope: string, message: string): void => {
    const entry: LogEntry = { time: new Date().toISOString(), level, scope, message };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    const line = scope ? `[${scope}] ${message}` : message;
    if (toConsole && order[level] >= order[consoleLevel]) (order[level] >= order.warn ? console.error : console.log)(line);
    if (file) {
      const text = `${entry.time} ${level.toUpperCase()} ${line}\n`;
      try {
        if (fileSize + text.length > maxFileBytes) { rotate(file, maxFiles); fileSize = 0; }
        fs.appendFileSync(file, text);
        fileSize += text.length;
      } catch { /* ignore */ }
    }
    for (const listener of listeners) { try { listener(entry); } catch { /* ignore */ } }
  };
  const make = (scope: string): Logger => ({
    debug: (message) => emit("debug", scope, message),
    info: (message) => emit("info", scope, message),
    warn: (message) => emit("warn", scope, message),
    error: (message) => emit("error", scope, message),
    child: (name) => make(scope ? `${scope}:${name}` : name),
    recent: (limit = ringSize) => ring.slice(-limit),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return make("");
}

export const silentLogger: Logger = createLogger({ console: false });
