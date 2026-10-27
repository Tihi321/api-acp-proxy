import { EventEmitter } from "node:events";

/** What a request asked for besides plain text. */
export type ActivityFeature = "images" | "imageGeneration" | "tools" | "mcp" | "search";
/**
 * One request as the activity log keeps it. Only metadata: never the prompt, the answer, a header or a key.
 * `status` is the HTTP status (a stream that fails after it started keeps 200 and has `error`); `error` is the proxy's error code.
 */
export interface ActivityEntry {
  /** Epoch ms of the request's start. */
  time: number;
  /** `GET /v1/models`, `POST /v1/chat/completions`, ... (`other` for a path the proxy does not serve). */
  endpoint: string;
  model?: string;
  /** The provider id the model routes to. */
  provider?: string;
  stream: boolean;
  features: ActivityFeature[];
  durationMs: number;
  status: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const DEFAULT_LIMIT = 100;
const dayKey = (time: number): string => { const date = new Date(time); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

/** In-memory ring buffer of the last requests (never written to disk). Emits "record" (the entry) and "change". */
export class ActivityLog extends EventEmitter {
  private entries: ActivityEntry[] = [];
  private todayKey = dayKey(Date.now());
  private todayCount = 0;
  private lastTime?: number;

  constructor(private readonly limit = DEFAULT_LIMIT, private readonly now: () => number = Date.now) { super(); }

  record(entry: ActivityEntry): void {
    const key = dayKey(this.now());
    if (key !== this.todayKey) { this.todayKey = key; this.todayCount = 0; }
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.todayCount++;
    this.lastTime = Math.max(this.lastTime ?? 0, entry.time);
    this.emit("record", entry);
    this.emit("change");
  }

  /** Newest first (by request start, the later one recorded first on a tie); `max` cuts the list. */
  list(max = this.limit): ActivityEntry[] { return [...this.entries].reverse().sort((a, b) => b.time - a.time).slice(0, max); }

  /** Requests since local midnight (counted, so more than the buffer holds is possible) and the start of the latest one. */
  summary(): { today: number; lastAt?: number } {
    if (dayKey(this.now()) !== this.todayKey) { this.todayKey = dayKey(this.now()); this.todayCount = 0; }
    return { today: this.todayCount, ...(this.lastTime !== undefined ? { lastAt: this.lastTime } : {}) };
  }

  clear(): void {
    this.entries = []; this.todayCount = 0; this.lastTime = undefined;
    this.emit("change");
  }
}

/** "3 requests today, last 2 min ago" (tray tooltip); "No requests yet" for an empty log. */
export function describeActivity(summary: { today: number; lastAt?: number }, now = Date.now()): string {
  if (!summary.today || summary.lastAt === undefined) return "No requests yet";
  const seconds = Math.max(0, Math.round((now - summary.lastAt) / 1000));
  const ago = seconds < 60 ? "<1 min ago" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86400)} d ago`;
  return `${summary.today} request${summary.today === 1 ? "" : "s"} today, last ${ago}`;
}
