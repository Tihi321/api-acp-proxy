import { ApiError } from "./api.js";

export const USAGE_LIMIT_CODE = "usage_limit_exceeded";
/** What a refused request carries beyond the common error fields (see the README, "Usage limit"). */
export interface UsageLimitExtra { retryAfterSeconds?: number; details?: Record<string, unknown>; /** Set by the pre-check refusal: the request never reached the agent. */ refused?: true; }

/** A provider said its subscription usage limit is used up. From a provider it carries the agent's reset text; the router turns it into the contract error (provider, `exhausted_until`, `retry_after`). */
export class UsageLimitError extends ApiError {
  /** True for a request refused before it ran (the provider was already exhausted); false for the failure that found the limit. */
  readonly refused: boolean;
  constructor(message: string, public readonly resetText?: string, extra: UsageLimitExtra = {}) {
    super(429, USAGE_LIMIT_CODE, message, "model", extra);
    this.refused = extra.refused === true;
    this.name = "UsageLimitError";
  }
}

/** The activity-log mark of a pre-check refusal (`refused: true`), so the usage totals leave it out; empty for any other error. */
export function refusedMark(error: unknown): { refused?: true } {
  return error instanceof UsageLimitError && error.refused ? { refused: true } : {};
}

/** The message of an error plus its JSON-RPC `data`, as one string to match against (the adapter puts the codes in `data`). */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let data = "";
  try { data = JSON.stringify((error as { data?: unknown } | null | undefined)?.data ?? "") ?? ""; } catch { /* unserialisable data is ignored */ }
  return `${message} ${data}`;
}

/** Codex: the typed `usageLimitExceeded` / `usage_limit_exceeded`, or the adapter's "You've hit your usage limit" text. `rateLimitExceeded`, `serverOverloaded` and everything else are not usage limits. */
export function matchCodexUsageLimit(error: unknown): boolean {
  return /usageLimitExceeded|usage_limit_exceeded|hit your usage limit/i.test(errorText(error));
}

/** The opt-in `usageLimitPattern` of a provider: true when the error text matches. Without a pattern nothing matches. */
export function matchPattern(error: unknown, pattern: RegExp | undefined): boolean {
  return pattern !== undefined && pattern.test(errorText(error));
}

/** Compiles a `usageLimitPattern` setting (case-insensitive); undefined for an empty or invalid one. */
export function compilePattern(source: string | undefined): RegExp | undefined {
  if (!source) return undefined;
  try { return new RegExp(source, "i"); } catch { return undefined; }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATED = /try again at\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i;
const TIME_ONLY = /try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i;
/** Antigravity's relative form: "reset in 6 days, 15 hours" (days, hours and minutes in any subset, singular or plural, joined by commas and/or "and"). */
const UNIT = String.raw`\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\b`;
const RELATIVE = new RegExp(String.raw`reset in\s+(${UNIT}(?:\s*,?\s*(?:and\s+)?${UNIT})*)`, "i");
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

function hour24(hour: number, meridiem: string): number | undefined {
  if (hour < 1 || hour > 12) return undefined;
  return (hour % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
}

/** The reset time (epoch ms) from "try again at <Mon> <D>[st|nd|rd|th], <YYYY> <h:mm> AM|PM" or "try again at <h:mm> AM|PM" (today, tomorrow when already past), read as the machine's local time (the text has no zone), or from Antigravity's relative "reset in N days, M hours" (`now` plus that). Anything else: undefined. */
export function parseResetTime(text: string, now: number): number | undefined {
  const dated = DATED.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.slice(0, 3).toLowerCase());
    const hour = hour24(Number(dated[4]), dated[6]!);
    const minute = Number(dated[5]);
    if (month < 0 || hour === undefined || minute > 59) return undefined;
    const year = Number(dated[3]), day = Number(dated[2]);
    const date = new Date(year, month, day, hour, minute);
    return date.getMonth() === month && date.getDate() === day ? date.getTime() : undefined;
  }
  const timeOnly = TIME_ONLY.exec(text);
  if (timeOnly) {
    const hour = hour24(Number(timeOnly[1]), timeOnly[3]!);
    const minute = Number(timeOnly[2]);
    if (hour === undefined || minute > 59) return undefined;
    const today = new Date(now);
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const relative = RELATIVE.exec(text);
  if (relative) {
    let total = 0;
    for (const part of relative[1]!.matchAll(/(\d+)\s*([dhm])/gi)) total += Number(part[1]) * UNIT_MS[part[2]!.toLowerCase()]!;
    return total > 0 ? now + total : undefined;
  }
  return undefined;
}

/** Antigravity's out-of-quota answer is at most this long (the whole answer, never the start of a longer one). */
export const ANTIGRAVITY_NOTICE_MAX_CHARS = 500;
const NOTICE_HEADING = "usage limit reached";
/** The answer without its leading whitespace and Markdown marks (`# * _ >`), in lower case. */
const noticeHead = (text: string): string => text.replace(/^[\s#*_>]+/, "").toLowerCase();

/** True while the text streamed so far can still become Antigravity's out-of-quota notice (a start of the heading, or the heading and more, within the cap): the provider holds such text back. */
export function couldBeAntigravityNotice(text: string): boolean {
  if (text.length > ANTIGRAVITY_NOTICE_MAX_CHARS) return false;
  const head = noticeHead(text);
  return head.length < NOTICE_HEADING.length ? NOTICE_HEADING.startsWith(head) : head.startsWith(NOTICE_HEADING);
}

/**
 * Antigravity answers a turn it has no quota for with text like "Usage Limit Reached ... Your limit will reset in 6 days, 15 hours" and ends the turn normally.
 * Strict, so that a genuine answer about usage limits is never taken for it: the whole answer is at most 500 characters, starts with the heading
 * "Usage Limit Reached" (after whitespace and Markdown marks) and holds a relative "reset in N <unit>". Wording from REQ-0025 bug 8; no full capture was found.
 */
export function matchAntigravityUsageLimit(text: string): boolean {
  return text.length <= ANTIGRAVITY_NOTICE_MAX_CHARS && noticeHead(text).startsWith(NOTICE_HEADING) && RELATIVE.test(text);
}

export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_RESET_MS = 31 * 24 * 60 * 60 * 1000;

/** The time a provider stays refused until: the parsed reset, or `now + cooldown` when there is none, it is in the past or it is over the cap. */
export function exhaustedUntil(resetText: string | undefined, now: number, cooldownMs: number, maxMs: number): number {
  const parsed = resetText ? parseResetTime(resetText, now) : undefined;
  return parsed !== undefined && parsed > now && parsed - now <= maxMs ? parsed : now + cooldownMs;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:mm` in the machine's local time. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The refusal of the contract: 429 `usage_limit_exceeded` with `Retry-After`, the provider id, `exhausted_until` (UTC ISO) and `retry_after` (whole seconds, at least 1). `refused` is true only for the pre-check (the request never ran the agent); the failure that found the limit passes false. */
export function usageLimitRefusal(provider: { id: string; displayName: string }, until: number, now: number, refused: boolean): UsageLimitError {
  const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
  return new UsageLimitError(
    `${provider.displayName} has hit its usage limit; it resets at ${localStamp(until)} (local time). Use another model or wait.`,
    undefined,
    { ...(refused ? { refused: true as const } : {}), retryAfterSeconds: retryAfter, details: { provider: provider.id, exhausted_until: new Date(until).toISOString(), retry_after: retryAfter } },
  );
}
