import { ApiError } from "./api.js";

export const USAGE_LIMIT_CODE = "usage_limit_exceeded";
/** What a refused request carries beyond the common error fields (see the README, "Usage limit"). */
export interface UsageLimitExtra { retryAfterSeconds?: number; details?: Record<string, unknown>; /** Set by the pre-check refusal: the request never reached the agent. */ refused?: true; /** The reset time (epoch ms) when the agent gave a timestamp (Claude's `resetsAt`); it wins over `resetText`. */ resetAt?: number; }

/** A provider said its subscription usage limit is used up. From a provider it carries the agent's reset text; the router turns it into the contract error (provider, `exhausted_until`, `retry_after`). */
export class UsageLimitError extends ApiError {
  /** True for a request refused before it ran (the provider was already exhausted); false for the failure that found the limit. */
  readonly refused: boolean;
  /** The reset time (epoch ms) the agent gave as a timestamp, if any. */
  readonly resetAt?: number;
  constructor(message: string, public readonly resetText?: string, extra: UsageLimitExtra = {}) {
    super(429, USAGE_LIMIT_CODE, message, "model", extra);
    this.refused = extra.refused === true;
    if (extra.resetAt !== undefined) this.resetAt = extra.resetAt;
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
/** Antigravity's relative form: "reset in 6 days, 15 hours" (weeks, days, hours and minutes in any subset, singular or plural, joined by commas and/or "and"). */
const UNIT = String.raw`\d+\s*(?:weeks?|wks?|days?|hours?|hrs?|minutes?|mins?)\b`;
const RELATIVE = new RegExp(String.raw`reset in\s+(${UNIT}(?:\s*,?\s*(?:and\s+)?${UNIT})*)`, "i");
const UNIT_MS: Record<string, number> = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 };

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
    for (const part of relative[1]!.matchAll(/(\d+)\s*([wdhm])/gi)) total += Number(part[1]) * UNIT_MS[part[2]!.toLowerCase()]!;
    return total > 0 ? now + total : undefined;
  }
  return undefined;
}

/** Antigravity's out-of-quota answer is at most this long (the whole answer, never the start of a longer one). */
export const ANTIGRAVITY_NOTICE_MAX_CHARS = 500;
const NOTICE_HEADING = "usage limit reached";
/** Leading whitespace and Markdown marks (`# * _`) of a line. Not `>`: a quoted heading is a quotation, not the agent's notice. */
const LEAD = /^[\s#*_]+/;
/** Trailing whitespace, Markdown marks and punctuation of a line. */
const TRAIL = /[\s#*_>\p{P}]+$/u;
/** The first non-empty line of the text and whether a line break already ends it; undefined while the text is blank. */
function firstLine(text: string): { line: string; complete: boolean } | undefined {
  const start = text.search(/\S/);
  if (start < 0) return undefined;
  const end = text.indexOf("\n", start);
  return end < 0 ? { line: text.slice(start), complete: false } : { line: text.slice(start, end), complete: true };
}
/** A line without leading whitespace and Markdown marks and without trailing whitespace, marks and punctuation, in lower case. */
const cleanLine = (line: string): string => line.replace(LEAD, "").replace(TRAIL, "").toLowerCase();
/** The heading followed on the same line by a sentence mark (`. ! :`, an en or an em dash): "Usage Limit Reached. Your limit will reset in ...". */
const HEADING_THEN_SENTENCE = /^usage limit reached[*_]*\s*[.!:\u2013\u2014]/i;
/** The notice's reset sentence: "Your limit will reset in N ...". */
const RESET_SENTENCE = /\byour limit will reset in\s+\d/i;
/** A complete first line is the notice's heading: the heading alone, or the heading, a sentence mark and the reset sentence on one line. */
const isHeadingLine = (line: string): boolean =>
  cleanLine(line) === NOTICE_HEADING || (HEADING_THEN_SENTENCE.test(line.replace(LEAD, "")) && RESET_SENTENCE.test(line));

/** True while the text streamed so far can still become Antigravity's out-of-quota notice (blank, a start of the heading line, the heading followed by a sentence mark, or a complete heading line, within the cap): the provider holds such text back. */
export function couldBeAntigravityNotice(text: string): boolean {
  if (text.length > ANTIGRAVITY_NOTICE_MAX_CHARS) return false;
  const first = firstLine(text);
  if (!first) return true;
  if (first.complete) return isHeadingLine(first.line);
  const head = first.line.replace(LEAD, "").toLowerCase();
  return head.length <= NOTICE_HEADING.length ? NOTICE_HEADING.startsWith(head) : cleanLine(head) === NOTICE_HEADING || HEADING_THEN_SENTENCE.test(head);
}

/**
 * Antigravity answers a turn it has no quota for with text like "Usage Limit Reached ... Your limit will reset in 6 days, 15 hours" and ends the turn normally.
 * Strict, so that a genuine answer about usage limits is never taken for it: the whole answer is at most 500 characters, its first non-empty line is
 * the heading "Usage Limit Reached" and nothing else (after whitespace, Markdown marks other than `>` and trailing punctuation), or the heading, a sentence mark
 * (`. ! :`, an en or an em dash) and the reset sentence on that one line, and the answer holds "your limit will reset in N".
 * Wording from REQ-0025 bug 8; no full capture was found.
 */
export function matchAntigravityUsageLimit(text: string): boolean {
  const first = firstLine(text);
  return text.length <= ANTIGRAVITY_NOTICE_MAX_CHARS && first !== undefined && isHeadingLine(first.line) && RESET_SENTENCE.test(text);
}

export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_RESET_MS = 31 * 24 * 60 * 60 * 1000;

/** The time a provider stays refused until: the agent's `resetAt`, else the reset parsed from its text, or `now + cooldown` when there is none, it is in the past or it is over the cap. */
export function exhaustedUntil(resetText: string | undefined, now: number, cooldownMs: number, maxMs: number, resetAt?: number): number {
  const parsed = resetAt ?? (resetText ? parseResetTime(resetText, now) : undefined);
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
