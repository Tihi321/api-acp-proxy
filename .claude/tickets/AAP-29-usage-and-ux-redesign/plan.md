---
status: done
request: REQ-0003
repos: [api-acp-proxy]
branch: AAP-29_usage-and-ux-redesign
updated: 2026-11-09
---

# AAP-29 usage per provider and a redesigned settings window

User request: "is it possible to add usage how much it was used for all providers, and redesign ux make it better". User answers: usage = BOTH proxy-counted totals AND account plan limits; redesign = the full settings window (not the tray); visual direction = our call, light and dark mode.

Reading of the request: the full one. (1) Persisted per-provider totals counted by the proxy, (2) account plan limits read from Codex and Claude on demand, (3) a new settings window layout with a sidebar and a token-based stylesheet. Branch `AAP-29_usage-and-ux-redesign`, cut from `master`.

Background: `research-limits.md` (how plan limits can be read) and `research-ui.md` (window, IPC, data flow, risks) in this folder. Read both before starting a task; this plan is the contract, the notes are the evidence.

## Scope

1. **Proxy-counted usage.** A persisted store `<dataDir>/usage.json`: per provider and per local day, `requests`, `errors`, `inputTokens`, `outputTokens`, `estimated` (requests whose token counts are the chars/4 estimate). Day buckets kept for 400 days; all-time totals kept separately and never pruned. Views: today, last 7 days, last 30 days, all time, and a per-day bar chart of the last 30 days. Every `ActivityLog` record with a `provider` counts as a request; a failed one (status >= 400 or `error` set) also counts as an error. Recorded through the controller, so the headless CLI persists too. "Reset usage" with a confirm dialog. Clearing Recent requests never touches the totals.
2. **Estimated flag.** `ActivityEntry.estimated: true` when the token counts are the chars/4 estimate (the agent reported no usage). The UI marks such numbers with "≈".
3. **Account plan limits.** Codex through `/status`, Claude through `/usage`, sent as the only text block of a throwaway session on the running agent; the reply markdown is parsed into windows (`label`, `usedPercent`, reset). Codex "% left" is normalised to used. Fetched only on demand (Refresh button; and when the Usage view opens, for ready providers whose cached value is older than 60 s); never on a background timer. Claude's pushed `usage_update._meta["_claude/rateLimit"]` is kept as a hint. Antigravity shows "Plan limits are not available for this provider". On a parse failure the (redacted) raw text is shown. The account email and cost lines are never logged or shown. Probe sessions are not in the activity log or the usage totals, take a slot of the provider's concurrency cap, never run while the provider needs login, and a custom `PROXY_ACP_COMMAND` Codex adapter is reported as unsupported instead of being probed.
4. **Redesign.** Plain TS + HTML + CSS, no framework, no bundler, CSP unchanged (no inline styles, scripts or handlers). Left sidebar with views Overview, Usage, Requests, Server, Codex, Claude, Antigravity and the footer actions. Design tokens (CSS variables), a spacing and type scale, clear status badges, light and dark through `prefers-color-scheme`. No feature removed (checklist in task T5).
5. **README** (and one ROADMAP line) updated.

## Out of scope

- Any tray change (`src/electron/tray.ts`; the tray keeps counting today's requests from the activity log).
- An HTTP usage endpoint or a `/healthz` extension.
- Antigravity's remote quota call (`retrieveUserQuota`); a second `codex app-server` process for structured rate limits.
- Cost estimates in money.
- A manual light/dark toggle (`nativeTheme`), web fonts, icon files.
- Renderer (DOM) tests.

## Discoveries (not fixed)

Record these in `discoveries.md` (format in the director state-files reference) when implementation starts:

- `SettingsView.server` lacks `reuseSessions` and `listBareAliases` although the UI reads them through `getPath` (`src/shared/ipc.ts:35-38`). Suggested: add the two fields.
- `GenerationCallbacks.onUsage` is declared and never called (`src/provider.ts:19`). Suggested: remove it or wire it. (Not related to the new `ProxyApi.onUsage`.)
- `server.workRoot` is in the schema and `SettingsView` but has no control in the window (`src/renderer/settings.html`). Suggested: a text field on the Server view.
- The tray's "N requests today" comes from `ActivityLog.summary()`, which **Clear** resets (`src/activity.ts:62`). Suggested: take it from the usage store later.

## Files and modules

| File | Task | Change |
| --- | --- | --- |
| `src/shared/ipc.ts` | T1 | New view types, `ActivityView.estimated`, `ProxyApi` additions |
| `src/usage-store.ts` (new) | T2 | `UsageStore`, `localDayKey` |
| `src/usage.ts` | T2 | `usageEstimated()` helper |
| `src/activity.ts` | T2 | `ActivityEntry.estimated` |
| `src/server.ts` | T2 | `Trace.estimated`, `traceUsage`, `track` |
| `src/mcp-endpoint.ts` | T2 | `Trace.estimated`, `ask_model` / `generate_image`, `record` |
| `src/controller.ts` | T2 | Store + plan-limits wiring, `ProviderRegistration.planLimits`, `usageSummary`, `resetUsage`, flush on stop |
| `tests/usage-store.test.ts` (new), `tests/controller.test.ts` | T2 | Store tests; one edited controller test |
| `src/plan-limits.ts` (new) | T3 | Parsers, redaction, hint reader, `PlanLimitsCache` |
| `src/provider.ts` | T3 | `PlanLimitsSpec`, descriptor fields, `Provider.planLimits` / `rateLimitHint` |
| `src/acp-provider.ts` | T3 | `planLimits()` probe, hint capture |
| `src/router.ts` | T3 | `probePlanLimits()` through the limiter |
| `src/providers/codex.ts`, `src/providers/claude.ts` | T3 | `planLimits` spec on the descriptor, `planLimits: true` on the registration |
| `tests/fixtures/fake-acp.mjs` | T3 | `FAKE_ACP_SLASH` switch |
| `tests/plan-limits.test.ts` (new) | T3 | Parser tests, probe test |
| `src/electron/preload.cts`, `src/electron/main.ts` | T4 | New IPC channels, usage push |
| `src/renderer/settings.html`, `src/renderer/settings.css`, `src/renderer/settings.ts` | T5 | Shell, navigation, tokens, all existing views |
| `src/renderer/usage-view.ts` (new), `src/renderer/usage.css` (new) | T6 | Usage view, overview usage strip, reset dialog wiring |
| `README.md`, `ROADMAP.md` | T7 | Docs |

`scripts/copy-static.mjs` already copies every `*.css` of `src/renderer`; no change. `src/electron/settings-window.ts` needs no change (the page stays `settings.html`; extra `.js` modules load as native ES modules).

## Ordering

- **T1 first** (types only; small). Everything else imports from it.
- **Then in parallel:** T2, T3, T4, T5, T6, T7. Each owns its files (table above); no two tasks edit the same file.
- T2 imports `PlanLimitsCache` from `src/plan-limits.ts` (T3) and T3's probe test calls the controller wiring (T2): the full typecheck and test run happen after **both** T2 and T3 are in. T4 compiles only after T2 and T3. T6 compiles only after T5 exists (it imports nothing from T5, but `settings.ts` imports T6's module).
- **Last:** full verification (see "Verification").

## Shared contract (T1: `src/shared/ipc.ts`)

`ipc.ts` stays types only. Add exactly:

```ts
/** One provider's (or the total's) counts over a range. `estimated`: requests whose token counts are the chars/4 estimate. */
export interface UsageCountsView { requests: number; errors: number; inputTokens: number; outputTokens: number; estimated: number }
export type UsageRangeKey = "today" | "last7" | "last30" | "allTime";
export interface UsageProviderView { id: string; today: UsageCountsView; last7: UsageCountsView; last30: UsageCountsView; allTime: UsageCountsView }
/** One local day; `byProvider` has an entry for every provider of `UsageView.providers` (zeros included). */
export interface UsageDayView { day: string /* YYYY-MM-DD, local */; byProvider: Record<string, UsageCountsView> }
export interface UsageView {
  generatedAt: number;
  /** Today's local day key, YYYY-MM-DD. */
  today: string;
  /** First day counted since the store was created or last reset (YYYY-MM-DD); absent when nothing was ever counted. */
  since?: string;
  /** Requested provider ids first, in the requested order, then any other id found in the data (sorted). */
  providers: UsageProviderView[];
  total: Record<UsageRangeKey, UsageCountsView>;
  /** Exactly 30 entries, oldest first, the last one is today; days without data are zero-filled. */
  days: UsageDayView[];
}

export interface PlanLimitWindowView {
  /** As the agent names it: "5h limit", "Weekly limit", "5-hour limit", "Weekly · all models", ... */
  label: string;
  /** 0-100, percent USED (Codex "% left" is converted). */
  usedPercent: number;
  /** Epoch ms, only when known exactly (the Claude push hint). */
  resetsAt?: number;
  /** The agent's own reset wording, e.g. "15:00", "09:30 on 12 Nov", "Nov 8, 3:00 PM GMT+1". */
  resetText?: string;
}
/** `idle`: never fetched. `ok`: windows parsed. `no_data`: the agent answered but has no limits (API key logins, "data not available yet"). `unparsed`: answer not understood, `raw` holds it (redacted). `unsupported`: the provider cannot report limits. `unavailable`: provider off, not installed, terms pending or server stopped. `needs_login`: not probed because the provider needs login. `error`: the probe failed (`message`). */
export type PlanLimitsState = "idle" | "ok" | "no_data" | "unparsed" | "unsupported" | "unavailable" | "needs_login" | "error";
/** Claude's pushed `_claude/rateLimit` (one window per event). `utilization` normalised to 0-100, `resetsAt` to epoch ms. */
export interface RateLimitHintView { status: "allowed" | "allowed_warning" | "rejected"; rateLimitType?: string; utilization?: number; resetsAt?: number; at: number }
export interface PlanLimitsView {
  provider: string;
  state: PlanLimitsState;
  windows: PlanLimitWindowView[];
  /** "ChatGPT plus", "API key", "Claude max": never an email. */
  plan?: string;
  /** Codex credits line, e.g. "unlimited". */
  credits?: string;
  /** Epoch ms of the probe's answer (ok, no_data, unparsed, error). */
  fetchedAt?: number;
  /** Only for `unparsed`: the reply with emails, cost lines and session/directory lines removed, at most 4000 characters. */
  raw?: string;
  message?: string;
  hint?: RateLimitHintView;
}
```

Also:

- `ActivityView` gains `estimated?: boolean` (true when the token counts are an estimate).
- `ProxyApi` gains:

```ts
  getUsage(): Promise<UsageView>;
  /** Sets every total back to zero and rewrites usage.json. */
  resetUsage(): Promise<ActionResult>;
  onUsage(callback: (usage: UsageView) => void): () => void;
  /** Cached plan limits, one per registered provider; never probes. */
  getPlanLimits(): Promise<PlanLimitsView[]>;
  /** Probes unless a value younger than 60 s exists and `force` is not true. */
  refreshPlanLimits(providerId: string, force?: boolean): Promise<PlanLimitsView>;
```

IPC channels (T4 implements, the preload maps them):

| Channel | Dir | Payload -> result |
| --- | --- | --- |
| `proxy:usage` | R->M invoke | -> `UsageView` |
| `proxy:usage` | M->R push | `UsageView`, 500 ms debounce on controller `"usage"` |
| `proxy:resetUsage` | R->M | -> `ActionResult` |
| `proxy:planLimits` | R->M | -> `PlanLimitsView[]` |
| `proxy:refreshPlanLimits` | R->M | `providerId: string, force?: boolean` -> `PlanLimitsView` |

Core modules import these types from `./shared/ipc.js` (precedent: `src/mcp-servers.ts:4`).

## Tasks

### T1. Shared types (`src/shared/ipc.ts`)

- Input: the contract above.
- Output: the types and `ProxyApi` members exactly as written. Nothing else changes in the file.
- Check: `tsc --noEmit -p tsconfig.renderer.json` still compiles the file (it will fail on `preload.cts` / `main.ts` until T4 lands; that is expected).

### T2. Usage store, estimated flag, controller wiring

Files: `src/usage-store.ts` (new), `src/usage.ts`, `src/activity.ts`, `src/server.ts`, `src/mcp-endpoint.ts`, `src/controller.ts`, `tests/usage-store.test.ts` (new), `tests/controller.test.ts`.

**Estimated flag**
- `src/usage.ts`: `export function usageEstimated(result: GenerationResult): boolean { return !result.usage; }` (the case where `openAiUsage` estimates). `openAiUsage` is unchanged (its tests stay as they are).
- `src/activity.ts`: `ActivityEntry` gains `/** The token counts are the chars/4 estimate (the agent reported none). */ estimated?: true;`. Keep the class comment "never written to disk": it is still true of the log.
- `src/server.ts`: `Trace` gains `estimated?: boolean`; `traceUsage` sets `trace.estimated = usageEstimated(result)`; `track` adds `...(trace.estimated && (trace.inputTokens !== undefined || trace.outputTokens !== undefined) ? { estimated: true as const } : {})`.
- `src/mcp-endpoint.ts`: `Trace` gains `estimated?: boolean`; at the two `openAiUsage` call sites (`ask_model` ~:696, `generate_image` ~:732) set `context.trace.estimated = usageEstimated(result)`; `record` adds the same `estimated` spread.

**`src/usage-store.ts`**

```ts
import type { ActivityEntry } from "./activity.js";
import type { Logger } from "./logger.js";
import type { UsageCountsView, UsageView } from "./shared/ipc.js";

export type UsageCounts = UsageCountsView;
/** The file: `since` = first counted day after creation or the last reset; `totals` = all time, never pruned; `days[YYYY-MM-DD][providerId]`. */
export interface UsageFile { version: 1; since?: string; totals: Record<string, UsageCounts>; days: Record<string, Record<string, UsageCounts>>; }
export interface UsageStoreOptions {
  /** Absent: in memory only (nothing is read or written). */
  file?: string;
  now?: () => number;
  /** Day buckets kept, today included. Default 400. */
  retainDays?: number;
  /** Delay between the first unsaved change and the write. Default 2000. */
  flushMs?: number;
  logger?: Logger;
}
/** Local calendar day, zero-padded: "2026-11-08". */
export function localDayKey(time: number): string;

/** Persisted request and token totals per provider and local day. Emits "change" after every add and reset. */
export class UsageStore extends EventEmitter {
  constructor(options?: UsageStoreOptions);
  /** Resolves once the file was read (missing, unreadable, invalid JSON or version !== 1: start empty, log a warning except for a missing file). */
  readonly ready: Promise<void>;
  /** Counts one activity entry; ignores entries without `provider`. Day = localDayKey(entry.time). */
  add(entry: ActivityEntry): void;
  summary(providerIds: readonly string[]): UsageView;
  /** Zeroes everything, sets `since` to today, writes the file at once (awaited), emits "change". */
  reset(): Promise<void>;
  /** Writes pending changes now (awaits `ready` first); resolves when the write is done. No-op without a file or without changes. */
  flush(): Promise<void>;
}
```

Rules:
- `add`: `requests += 1`; `errors += 1` when `entry.status >= 400 || entry.error !== undefined`; `inputTokens += entry.inputTokens ?? 0`; `outputTokens += entry.outputTokens ?? 0`; `estimated += 1` when `entry.estimated`. Update both `days[day][provider]` and `totals[provider]`; set `since` when absent. Prune day keys older than `retainDays - 1` days before today (compare day keys built by stepping a local `Date` back with `setDate`, which is DST-safe). Emit "change". Schedule a write (`setTimeout(flushMs).unref()`), one pending timer at a time.
- Load merges: the constructor starts `ready = load()`; adds made before the load finished are kept and the file's counts are added to them (so an early request is never lost). Writes wait for `ready`, so a partial state never overwrites the file.
- Write: `{ version: 1, since, totals, days }` (`JSON.stringify(..., null, 2)`), `mkdir -p`, write `<file>.tmp-<pid>`, rename, with the EPERM / EBUSY / EACCES retry of `SettingsStore.save` (`src/settings.ts:186-205`; up to 4 retries with a short delay). Writes are serialized on one promise chain. A failed write is logged at `warn` and does not throw from `add`. Never log counts per request.
- `summary(ids)`: ranges are local days: `today`; `last7` = today and the 6 days before; `last30` = today and the 29 days before; `allTime` = `totals`. Missing providers get zeros. `days` = exactly 30 entries ending today, every provider id of the result in each `byProvider`. `total` sums the providers.

**Controller (`src/controller.ts`)**
- `ProviderRegistration` gains `/** The provider can report account plan limits (T3 sets it for Codex and Claude). */ planLimits?: boolean;`.
- Fields (constructor, after `dataDir` is known):
  ```ts
  /** Per-provider request and token totals, persisted in <dataDir>/usage.json; survives Clear and restarts. */
  readonly usage: UsageStore;
  /** Account plan limits, fetched on demand and cached for 60 s. */
  readonly planLimits: PlanLimitsCache;
  ```
  `this.usage = new UsageStore({ file: path.join(this.dataDir, "usage.json"), logger: this.logger })`; `this.usage.on("change", () => this.emit("usage"))`; in the existing `activity.on("record")` listener (or a second one) call `this.usage.add(entry)` first, before the `loginNeeded` check.
  ```ts
  this.planLimits = new PlanLimitsCache({
    providerIds: () => this.registry.map((entry) => entry.id),
    supported: (id) => this.registry.find((entry) => entry.id === id)?.planLimits === true,
    live: (id) => {
      const running = this.running;
      const provider = running?.providers.find((entry) => entry.id === id);
      return running && provider ? { provider, probe: (signal) => running.router.probePlanLimits(id, signal) } : undefined;
    },
  });
  ```
- Methods: `usageSummary(): UsageView { return this.usage.summary(this.registry.map((entry) => entry.id)); }`; `async resetUsage(): Promise<void> { await this.usage.reset(); }`.
- `stop()`: after `stopServer()`, `await this.usage.flush()` (errors caught and logged). `before-quit` in `main.ts` and SIGINT/SIGTERM in `index.ts` already call `stop()`, so the CLI and the app both flush.
- `logout()`: after a successful `provider.logout()`, call `this.planLimits.forget(providerId)`.
- Update the class comment: it also emits `"usage"` when the totals change.

**Tests** (test-discipline: few, no near-duplicates; injected `now`, files under `.claude/temp/usage-store-tests/<pid>`):
- `tests/usage-store.test.ts`:
  1. "counts requests, errors, tokens and estimates per provider and local day": entries for `codex` today (one ok with tokens, one 503 error, one `estimated`), `claude` 3 days ago, `codex` 10 days ago and 40 days ago, one entry without provider. Expect `today` / `last7` / `last30` / `allTime` for codex and claude and `total`; the no-provider entry ignored; `days` has 30 entries ending with `today`, zero-filled, and the claude day bucket in the right place.
  2. "persists to usage.json, prunes old days, keeps all-time totals, and survives a broken file": `retainDays: 5`, add today and 8 days ago, `flush()`, a new store on the same file has the same `summary`; the file's `days` has no 8-days-ago key but `allTime` counts it. A file with `{not json` loads as empty and `ready` resolves.
  3. "resets the totals and the file": after `reset()` every count is 0, the file has empty `totals` / `days` and `since === today`; a later `add` counts again.
- `tests/controller.test.ts`, edit "keeps the activity of the requests, across a restart, ...": after `controller.activity.clear()`, add `expect(controller.usageSummary().total.today).toMatchObject({ requests: 1 })` (the chat request has provider `codex`; the models listing has none). This proves the wiring and that Clear leaves totals alone.

### T3. Plan-limit probe and parsers

Files: `src/plan-limits.ts` (new), `src/provider.ts`, `src/acp-provider.ts`, `src/router.ts`, `src/providers/codex.ts`, `src/providers/claude.ts`, `tests/fixtures/fake-acp.mjs`, `tests/plan-limits.test.ts` (new).

**`src/plan-limits.ts`**

```ts
import type { PlanLimitWindowView, PlanLimitsView, RateLimitHintView } from "./shared/ipc.js";
import type { Provider } from "./provider.js";

export type PlanLimits = PlanLimitsView;
export interface ParsedPlanLimits { windows: PlanLimitWindowView[]; plan?: string; credits?: string; }
/** Codex `/status` markdown (codex-acp 2.3.0). undefined when the text is not a status message. */
export function parseCodexStatus(text: string): ParsedPlanLimits | undefined;
/** Claude `/usage` markdown (claude-agent-acp 0.91.0). undefined when the text is not a usage message. */
export function parseClaudeUsage(text: string): ParsedPlanLimits | undefined;
/** Removes e-mail addresses, lines with a "$" amount, "**Account:**", "**Directory:**", "**Session:**" lines and everything from "### This session" on; trims to 4000 characters. */
export function redactLimitsText(text: string): string;
/** Reads `_meta["_claude/rateLimit"]` of a usage_update; undefined when absent or invalid. */
export function readRateLimitHint(meta: unknown, now: number): RateLimitHintView | undefined;

export interface PlanLimitsCacheDeps {
  providerIds(): string[];
  supported(id: string): boolean;
  /** The running provider and a probe that goes through the router's limiter; undefined when the server is stopped or the provider is off. */
  live(id: string): { provider: Provider; probe(signal: AbortSignal): Promise<PlanLimits> } | undefined;
  now?: () => number;
}
export class PlanLimitsCache {
  constructor(deps: PlanLimitsCacheDeps, maxAgeMs?: number /* 60_000 */);
  /** One entry per provider id, from the cache only (never probes): unsupported / unavailable / idle when nothing is cached; `hint` merged from the live provider. */
  list(): PlanLimits[];
  /** Probes unless `force` is false and a cached `ok` / `no_data` / `unparsed` value is younger than maxAgeMs; concurrent calls for one id share one probe. */
  get(id: string, force?: boolean): Promise<PlanLimits>;
  /** Drops the cached value of one provider (after a logout). */
  forget(id: string): void;
}
```

Parser rules (lines: split on `/\r?\n/`, trim each, Codex joins lines with two spaces + newline):
- **Codex** (format: `codex-acp/dist/index.js:44118-44275`).
  - Recognised when any line starts with `**Model:**`, `**Limits:**` or matches a window; otherwise `undefined`.
  - Window: `/^\*\*(.+?):\*\*\s*(\d+(?:\.\d+)?)% left\b(?:\s*\((.*)\))?/` where the label ends with `limit` (case-insensitive; covers `5h limit`, `Weekly limit`, `<name> 5h limit`, `individual spend limit`). `usedPercent = clamp(100 - left, 0, 100)`. `resetText` = the text after `resets ` inside the parentheses (for the spend limit, after `; resets `), trimmed.
  - `**Limits:** data not available yet` -> no windows.
  - Plan: `**Account:** ChatGPT <plan> (<email>)` -> `plan: "ChatGPT <plan>"` (drop the parenthesis); `API key configured` -> `plan: "API key"`; `not logged in` -> no plan.
  - Credits: `**[<name> ]Credits:** <value>` -> `credits: <value>`.
- **Claude** (format: `claude-agent-acp/dist/usage-markdown.js`, `formatUsageResponse`).
  - Recognised when a line is `## Usage` or matches a window; otherwise `undefined`.
  - Window: `/^\*\*(.+?)\*\*\s*—\s*\*\*(\d+(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+(.+))?$/`; unescape `\\(.)` -> `$1` in the label; `usedPercent` as is (it is USED); `resetText` = group 3.
  - Plan: `> Claude <type> subscription usage` -> `plan: "Claude <type>"`.
  - Ignore everything after a `---` line that follows the limits (session cost, behaviours).
- `readRateLimitHint`: `status` must be `allowed` | `allowed_warning` | `rejected`; `utilization` number: `<= 1` -> `x * 100`, else as is, rounded to 1 decimal; `resetsAt` number: `< 1e12` -> seconds, `* 1000`; `rateLimitType` string kept; `at = now`.

Sample texts (use them in the tests; the email and the cost row must not survive parsing or redaction):

Codex `/status` (lines joined with `"  \n"`):
```
**Model:** gpt-6-luna
**Directory:** C:\Temp\request-abc
**Approval:** never
**Sandbox:** read-only
**Account:** ChatGPT plus (someone@example.com)
**Session:** `019a-test`

**Token usage:** data not available yet
**Context window:** data not available yet
**5h limit:** 66% left (resets 15:00)
**Weekly limit:** 91% left (resets 09:30 on 12 Nov)
**Credits:** unlimited
```
Expected: windows `[{ label: "5h limit", usedPercent: 34, resetText: "15:00" }, { label: "Weekly limit", usedPercent: 9, resetText: "09:30 on 12 Nov" }]`, `plan: "ChatGPT plus"`, `credits: "unlimited"`. With the last three lines replaced by `**Limits:** data not available yet`: windows `[]`.

Claude `/usage`:
```
## Usage

> Claude max subscription usage

### Limits

**5-hour limit** — **34%** · Resets Nov 8, 3:00 PM GMT+1

`███████░░░░░░░░░░░░░`

**Weekly · all models** — **12%** · Resets Nov 12, 9:00 AM GMT+1

`██░░░░░░░░░░░░░░░░░░`

**Weekly · Opus** — **0%**

`░░░░░░░░░░░░░░░░░░░░`

---

### This session

| Cost | API time | Active |
|:--|:--|:--|
| $0.42 | 3s | 5s |
```
Expected: windows `5-hour limit` 34 `Nov 8, 3:00 PM GMT+1`, `Weekly · all models` 12 `Nov 12, 9:00 AM GMT+1`, `Weekly · Opus` 0 (no `resetText`); `plan: "Claude max"`. `## Usage` alone (API key login): windows `[]`.

**`src/provider.ts`**
- `export interface PlanLimitsSpec { /** Slash command sent as the only text block, e.g. "/status". */ command: string; parse(text: string): ParsedPlanLimits | undefined; }` (import `ParsedPlanLimits` as a type from `./plan-limits.js`).
- `ProviderDescriptor` gains `planLimits?: PlanLimitsSpec;` and `/** Why plan limits are not available (shown instead of the generic text), e.g. a custom adapter. */ planLimitsUnavailable?: string;`.
- `Provider` gains optional `planLimits?(signal?: AbortSignal): Promise<PlanLimitsView>;` and `rateLimitHint?(): RateLimitHintView | undefined;`.

**`src/acp-provider.ts`**
- Hint: in the `session/update` notification handler of `doStart` (~:372, `app.onNotification(methods.client.session.update, ...)`), before dispatching to `handlers`, when `params.update.sessionUpdate === "usage_update"`, `const hint = readRateLimitHint((params.update as { _meta?: unknown })._meta, Date.now()); if (hint) this.hint = hint;`. `rateLimitHint()` returns it. Nothing is logged.
- `async planLimits(signal?: AbortSignal): Promise<PlanLimitsView>`:
  1. No `descriptor.planLimits` -> `{ state: "unsupported", message: descriptor.planLimitsUnavailable ?? "Plan limits are not available for this provider." }`.
  2. `status().state === "needs_login"` -> `{ state: "needs_login", message: "Log in to <name> to see its plan limits." }` without starting anything. `not_installed` / `terms_required` / `disabled` -> `unavailable` with `status().error` or a generic message.
  3. `agent = await this.start()`; `session = await this.createSession(agent)` (a fresh session: never `warm.shift()`, never `takeKept`, no `refillWarm`, never `keep`). Register a handler that appends `agent_message_chunk` text. If `session.readOnlyModeId`, set that mode (no error when missing; the model is NOT set). Send `session/prompt` with `prompt: [{ type: "text", text: spec.command }]` (no `buildPrompt`, no preamble), wrapped in `authGuard` and a 30 s timeout; on timeout or `signal` abort send `session/cancel`.
  4. `finally`: `disposeSession(agent, session)`.
  5. Result: `ProviderAuthRequiredError` -> `needs_login`; other errors -> `{ state: "error", message: <error message> }` (never the reply text). Text empty -> `error` "<name> sent no answer to <command>; this agent version may not support it.". `spec.parse(text)` undefined -> `{ state: "unparsed", raw: redactLimitsText(text), fetchedAt }`. Windows empty -> `no_data`; else `ok`. Copy `plan` / `credits`. Set `fetchedAt = Date.now()`.
  6. Log only `debug` "Plan limits from <command>: <n> windows" or the error message; never the text.
- The probe does not go through `server.ts` or `mcp-endpoint.ts`, so it is never recorded in the activity log or counted in the usage totals.

**`src/router.ts`**
- `async probePlanLimits(providerId: string, signal: AbortSignal): Promise<PlanLimitsView>`: unknown provider or no `provider.planLimits` -> `unsupported`. With a limiter: `release = await limiter.acquire(signal)`; `QueueAbortedError` -> `{ state: "error", message: "No free slot for this provider in time; try again." }`; `ApiError` with code `provider_queue_full` -> `{ state: "error", message: "The provider's queue is full; try again shortly." }`. Then `try { return await provider.planLimits(signal); } finally { release(); }`. Every returned view has `provider: providerId` and `windows` (empty when none).

**`PlanLimitsCache.get(id, force)`**: not `supported(id)` -> `unsupported` (Antigravity always lands here, running or not); `live(id)` undefined -> `unavailable` ("Turn the provider on and start the server first."); provider state `needs_login` -> `needs_login` (no probe); fresh cached value and not `force` -> cached; otherwise `probe(AbortSignal.timeout(45_000))`, store the result (also `error` ones, but only `ok` / `no_data` / `unparsed` count as fresh). A thrown error becomes `{ state: "error", message }`. Every returned value gets `hint` from `live(id)?.provider.rateLimitHint?.()` when present.

**Descriptors and registrations**
- `src/providers/codex.ts`: in `codexDescriptor`, `...(config.acpCommand ? { planLimitsUnavailable: "Plan limits need the bundled Codex adapter; PROXY_ACP_COMMAND is set." } : { planLimits: { command: "/status", parse: parseCodexStatus } })`. `codexRegistration` gets `planLimits: true`.
- `src/providers/claude.ts`: descriptor `planLimits: { command: "/usage", parse: parseClaudeUsage }`; `claudeRegistration` gets `planLimits: true`.
- Antigravity: unchanged (no spec, no flag).

**Fake agent** (`tests/fixtures/fake-acp.mjs`): new switch, documented in the header comment: `FAKE_ACP_SLASH=<json>` maps a command to markdown, e.g. `{"/status": "..."}`. In `session/prompt`, when the prompt is exactly one text block whose text is a key, answer that markdown as one `agent_message_chunk` and finish with `end_turn` (no delay, no other switch applies).

**Tests** (`tests/plan-limits.test.ts`):
1. "parses Codex /status into used percentages, plan and credits, without the e-mail": the sample; the no-data variant; `parseCodexStatus("hello")` is undefined; `JSON.stringify(result)` has no `someone@example.com`.
2. "parses Claude /usage windows and plan, and redaction drops the cost and e-mail": the sample; `## Usage` alone gives no windows; garbage is undefined; `redactLimitsText(sample + "\nme@example.com")` contains neither `$0.42` nor the address.
3. "probes in a throwaway session that is neither logged as activity nor counted, and caches the answer": controller (`make` helper pattern of `tests/controller.test.ts`: tmp settings file, `signedIn: true`) with a registry entry `{ id: "codex", displayName: "Codex", planLimits: true, create: ({ config, ctx }) => new AcpProvider({ ...codexDescriptor({ acpCommand: undefined, acpArgs: [] }), launch: () => ({ command: process.execPath, args: [fixture], env: { ...process.env } }), planLimits: { command: "/status", parse: parseCodexStatus } }, ctx, { workRoot: config.workRoot }) }`, `FAKE_ACP_SLASH` with the Codex sample and `FAKE_ACP_LOG`. After `start()`: `planLimits.get("codex")` is `ok` with the two windows; `planLimits.get("codex")` again does not send a second prompt (log); the logged `session/prompt` has exactly `[{ type: "text", text: "/status" }]`; no `session/set_config_option` was logged for the probe session; `controller.activity.list()` is empty; `controller.usageSummary().total.allTime.requests` is 0; `planLimits.get("antigravity")` is `unsupported`. Then a controller without `signedIn` (Codex needs login): `planLimits.get("codex", true)` is `needs_login` and the log has no `session/prompt`.

### T4. IPC wiring (`src/electron/preload.cts`, `src/electron/main.ts`)

- Preload: add to `api` (types from `ipc.ts`):
  ```ts
  getUsage: () => invoke("proxy:usage"),
  resetUsage: () => invoke("proxy:resetUsage"),
  onUsage: (callback) => subscribe<UsageView>("proxy:usage", callback),
  getPlanLimits: () => invoke("proxy:planLimits"),
  refreshPlanLimits: (providerId, force) => invoke("proxy:refreshPlanLimits", providerId, force),
  ```
- `main.ts`:
  - `const usageView = (): UsageView => proxy.usageSummary();` and a `pushUsage` with a 500 ms debounce like `pushActivity` (`win.send("proxy:usage", usageView())` when `win.webContents`); `proxy.on("usage", pushUsage)`.
  - `handle("proxy:usage", () => usageView())`; `handle("proxy:resetUsage", () => action(() => proxy.resetUsage()))`; `handle("proxy:planLimits", () => proxy.planLimits.list())`; `handle("proxy:refreshPlanLimits", (providerId: unknown, force: unknown) => typeof providerId === "string" ? proxy.planLimits.get(providerId, force === true) : { provider: "", state: "error", windows: [], message: "Invalid provider" })`.
  - All go through the existing `handle` (sender check stays).
- Nothing else in `main.ts` changes (tray untouched).

### T5. Renderer shell and existing views (`settings.html`, `settings.css`, `settings.ts`)

**Visual direction: "quiet console".** A calm desktop utility: warm-grey surfaces, one ink-blue accent for actions and focus, color reserved for status (badges, meters, chart series), monospace for addresses, ids and numbers. Dense but breathable: 13 px body, 4 px spacing grid, cards with hairline borders and no heavy shadows.

Tokens (`settings.css`, `:root`; dark values under `@media (prefers-color-scheme: dark)`; keep `color-scheme: light dark` and the `<meta name="color-scheme">`):

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` (content) | `#f6f5f3` | `#16181b` |
| `--surface` (cards, inputs) | `#ffffff` | `#1d2024` |
| `--surface-2` (sidebar, table head, chips) | `#efeeeb` | `#23272c` |
| `--surface-hover` | `#e8e6e2` | `#2a2f35` |
| `--border` | `#e2e0db` | `#2e3338` |
| `--border-strong` | `#cfccc5` | `#3b4148` |
| `--text` | `#1f2328` | `#e7e9ec` |
| `--text-muted` | `#5f6670` | `#a1a8b1` |
| `--text-faint` | `#8a9099` | `#737b85` |
| `--accent` | `#2f5bd3` | `#7a9cf5` |
| `--accent-hover` | `#264bb0` | `#93b0f8` |
| `--accent-fg` | `#ffffff` | `#0e1420` |
| `--accent-soft` | `#e6ecfb` | `#233057` |
| `--ok` / `--ok-soft` | `#1a7f4b` / `#e3f3ea` | `#4cc38a` / `#173326` |
| `--warn` / `--warn-soft` | `#a35f00` / `#fbefdc` | `#e5a54b` / `#3a2a12` |
| `--err` / `--err-soft` | `#c4322b` / `#fbe5e3` | `#f07167` / `#3d1c1a` |
| `--series-codex` | `#2f5bd3` | `#7a9cf5` |
| `--series-claude` | `#c2573a` | `#e08a68` |
| `--series-antigravity` | `#24877b` | `#4fc1b3` |
| `--series-other` | `#8a9099` | `#737b85` |
| `--shadow-1` | `0 1px 2px rgba(20,22,26,.06)` | `0 1px 2px rgba(0,0,0,.4)` |

Type: `--font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; `--font-mono: "Cascadia Mono", Consolas, ui-monospace, monospace`. Scale: `--text-xs 11px`, `--text-sm 12px`, `--text-md 13px` (body, line-height 1.45), `--text-lg 15px` (card titles, 600), `--text-xl 18px` (view titles, 600), `--text-2xl 22px` (stat numbers, 600, tabular-nums). Weights 400 and 600 only.

Spacing: `--space-1 4px`, `--space-2 8px`, `--space-3 12px`, `--space-4 16px`, `--space-5 20px`, `--space-6 24px`, `--space-8 32px`. Radius: `--radius-sm 4px`, `--radius-md 6px`, `--radius-lg 10px`. Transitions only on hover/focus colors, 120 ms, disabled under `prefers-reduced-motion: reduce`.

Layout:
- `body` > `.app` grid: `grid-template-columns: 224px 1fr; height: 100vh`. Sidebar never scrolls with the content; `main.content` has `overflow: auto`, padding `--space-6`, inner `.view` max-width 880px.
- Under 760 px width: sidebar 176px, the sidebar subtitle and the settings-path line hidden.
- Each view: `.view-head` (h1 at `--text-xl`, a one-line `.view-sub` in `--text-muted`, right-aligned `.view-actions`), then `.card`s with `--space-4` gap.
- Provider and Server views end in a `.save-bar`: `position: sticky; bottom: 0`, `--surface` background, top border, holds the Save and restart button, the restart hint, the `msg` and the `general-error` line.

Sidebar markup (`<aside class="sidebar">`):
- `.brand`: a 18 px `.brand-mark` (CSS-drawn rounded square, accent gradient, `aria-hidden`), "ACP Proxy", subtitle "OpenAI-compatible API over your agents".
- `.server-pill`: `#top-badge` and `#top-url` (ids kept).
- `<nav aria-label="Sections">`: group label "General", buttons `.nav-item[data-view]` for `overview`, `usage`, `requests`, `server`; group label "Providers", buttons for `codex`, `claude`, `antigravity`. Server and provider items carry a `<span class="nav-dot" data-role="nav-dot">` colored from the badge class (`ok`, `warn`, `err`, `info`, neutral). The active item has `aria-current="page"`. An item whose scope has unsaved edits gets `.is-dirty` (a small accent dot and `title="Unsaved changes"`).
- `.sidebar-foot`: `#open-logs` button, "Settings:" + `#settings-path` (mono, ellipsis, `title` = full path), `#secrets-note`.

Components (all in `settings.css`; T6 relies on the ones marked shared):
- Buttons (shared): base `button` (surface, border, `--radius-md`, 6px 12px), `.primary` (accent), `.danger` (err fill), `.small` (3px 8px, `--text-sm`), `.quiet-danger` (surface, err text, err border on hover), `.link-button` (no border, accent text).
- `.badge` (shared): pill, `--text-xs` 600, 2px 8px, a 6 px leading dot in `currentColor`; `.ok` / `.warn` / `.err` / `.info` use the color on its `-soft` background; neutral uses `--surface-2` and `--text-muted`. Text stays sentence case ("needs login").
- `.card` (shared) with `.card-head` (title `h2` at `--text-lg`, optional right side), `.card-sub` line.
- `.segmented` (shared): a row of buttons inside one rounded border; the pressed one has `aria-pressed="true"`, `--surface` background on a `--surface-2` track.
- `.table` (shared): `--text-sm`, head on `--surface-2`, uppercase `--text-xs` head labels, `td.num` right-aligned tabular-nums, `tr.total td` 600 with a top border, `td.ok` / `td.bad` colors.
- `.stats` / `.stat` (shared): a responsive grid (`repeat(auto-fit, minmax(150px, 1fr))`) of tiles: `.stat-label` (`--text-xs`, muted, uppercase), `.stat-value` (`--text-2xl`), `.stat-sub` (`--text-xs` muted). `.approx` = muted "≈ " prefix.
- `.note` (shared): `--text-sm` muted paragraph. `.empty-state` (shared): centered muted text with `--space-6` padding.
- Fields: `.field`, `.grid` (two columns >= 640 px content width), `.check`, `.switch` (restyle the existing checkbox label as a switch-looking control with CSS only; it stays an `<input type="checkbox">`), `fieldset.sub`, `.chips`, `.login-link`, `.status-line`, `.row`, `.between`, `.push`, `.error`, `.msg` / `.msg.bad`, `small:empty` hidden, `[hidden] { display: none !important }` (keep).
- Dialogs: `--radius-lg`, `--shadow-1`, backdrop `rgba(0,0,0,.45)`.

Views and ids. Every view is `<section class="view" id="view-<name>" data-view="<name>" aria-labelledby="<name>-title">`. Hidden views use `hidden` (they stay in the DOM, so the Antigravity install progress and every `data-role` element keep working). The old card ids stay on an inner `<div class="view-body" id="card-...">` that contains all the role and field elements, so `card()`, `role()` and `showErrors` keep working unchanged:
- **Overview** (`#card-overview`): API address line (`ov-url`, `ov-copy`, `ov-playground`), MCP line (`ov-mcp-url`, `ov-mcp-copy`); a "Today" card with `<div class="stats" id="ov-usage"></div>` and `<button id="ov-usage-open" class="small link-button">Open usage</button>` (T6 fills `ov-usage`); the provider rows `#ov-providers` (order Codex, Claude, Antigravity; each row gets a "Settings" `.small` button that opens that provider's view); `#ov-msg`; the MCP servers block (`ov-mcp`, `ov-mcp-count`, `open-settings-file`).
- **Usage** (T6 markup contract below, written by T5 in `settings.html`).
- **Requests** (`#card-activity`): `act-summary`, `act-clear`, `act-table`, `act-body`, `act-empty`. `#act-empty` text: "No requests yet. They show up here as they come in. Only their kind, model, timing and token counts are kept, in memory (the last 100), never the text. Totals per provider are on the Usage page and are not affected by Clear."
- **Server** (`#card-server`): view actions `server-badge` + `server-toggle`; cards "Address" (`server-url`, `copy-url`, `server-error`, `server.host`, `server.port`), "Access" (`server.apiKey`, `server-key-show`, `server-key-gen`), "Limits and timeouts" (`server.timeoutMs`, `server.maxBodyBytes`, `server.modelsWaitMs`, `server.toolResultTimeoutMs`, `server.maxConcurrent`, `server.maxQueue`), "Behaviour" (`server.launchAtLogin`, `server.listBareAliases`, `server.reuseSessions`); save bar with `server-save`, the "Saving restarts the server; in-flight requests will be dropped after 5 s." hint, `server-msg`, `server-general-error`.
- **Codex** (`#card-codex`, `data-provider="codex"`): head with name, `badge`, `version`, `providers.codex.enabled` switch; cards "Sign-in" (`error`, auth select + `login`, `login-link` / `login-url` / `copy-login`, `providers.codex.isolatedHome`, Codex home row `codex-home-path` + `open-codex-home`), "Capacity" (`providers.codex.maxConcurrent`), "Models" (`model-count`, `refresh`, `models`); save bar (`save`, `msg`, `general-error`).
- **Claude** (`#card-claude`): as Codex plus the terms blurb, `account`, and the "Credentials and data" fieldset (`providers.claude.apiKey` + `claude-key-show`, `providers.claude.oauthToken` + `claude-token-show`, `providers.claude.configDir`, `providers.claude.executablePath` + `browse-claude-exe`).
- **Antigravity** (`#card-antigravity`): as Codex (no isolated home) plus fieldset "Agent" (`providers.antigravity.executablePath`, `browse-exe`, `install-agy`, `install-progress`, `install-text`, `install-info`) and "Credentials and data" (`providers.antigravity.apiKey` + `agy-key-show`, `providers.antigravity.geminiHome`, `providers.antigravity.purgeSessions`).
- Every `data-note-for`, `data-error-for` element stays next to its field. Dialogs `#logout-dialog` and `#terms-dialog` unchanged in ids. Add `#reset-usage-dialog` (T6 wires it): `<h2 id="reset-usage-title">Reset usage totals?</h2>`, body "This sets the request and token counts of every provider back to zero and clears the daily history in usage.json. Recent requests and plan limits are not affected. This cannot be undone.", buttons `#reset-usage-cancel` and `#reset-usage-confirm` (`danger`, "Reset").
- Stylesheets: `<link rel="stylesheet" href="settings.css">` then `<link rel="stylesheet" href="usage.css">`.

`settings.ts` changes (keep everything else as it is):
- Navigation: `const views = ["overview", "usage", "requests", "server", "codex", "claude", "antigravity"] as const;` `showView(name)` toggles `hidden` on the views, sets `aria-current` on the nav items, stores the name in `localStorage["acp-proxy.view"]` (read and write in try/catch; fall back to `overview`), and calls `usage.shown()` when the view is `usage`. Wire with `addEventListener` (no inline handlers).
- `const usage = initUsageView({ api, showView });` (import from `./usage-view.js`); call `usage.setState(current)` at the end of `render()`.
- Dirty marker: one `markDirty(scope, value)` that sets `dirty[scope]` and toggles `.is-dirty` on the nav item; use it where `dirty` is set today (input/change listeners, key generator, both Browse buttons, `saveScope` success).
- Nav dots: in `render()`, set each `[data-role="nav-dot"]` class from `badgeClass` of the server state and of each provider state.
- `providerOrder = ["codex", "claude", "antigravity"]`. Texts: "Off. Turn it on in its card below." -> "Off. Turn it on on its page."; the Log in title "Sign in with the method picked in the card below." -> "Sign in with the method picked on its page."
- `renderActivity`: the token cell prefixes `≈ ` and sets `title="Estimated: about 4 characters per token"` when `entry.estimated`; `ENDPOINT_LABELS` gains `"MCP ask_model": "MCP ask"` and `"MCP generate_image": "MCP image"`.
- No other logic changes: `fields`, `collectPatch`, `renderFields`, `renderAuth`, terms gating, login/logout (including the shared-login-home paragraph of `logoutText`), install progress, `copyText`, `openExternal` stay as they are.

Feature checklist (each must still work; verify in the app, see A12):
server start/stop/retry, copy URL (two places), API key show/generate, every server field and checkbox incl. `launchAtLogin` side effect, env-forced fields disabled with the note and skipped on save, per-scope Save and restart with field errors, provider enable with terms dialog (on toggle and on save), auth method select (kept while dirty; Claude subscription-only default), Log in (overview and provider page) with the login link box, Log out with the confirmation (shared home warning), Claude console-login message, account line, models list + Refresh, Codex isolated home + Open folder, Antigravity Browse / Download with progress / install info, Claude Browse, secrets (empty input sends `null`, apiKey not trimmed), MCP URL + Copy command, playground, MCP servers list + Open settings.json, Recent requests + Clear, Open logs folder, settings path and secrets note.

### T6. Usage view (`src/renderer/usage-view.ts`, `src/renderer/usage.css`)

Exports:

```ts
import type { ProxyApi, StateView } from "../shared/ipc.js";
export interface UsageViewDeps { api: ProxyApi; showView(name: string): void; }
export interface UsageViewHandle {
  /** The Usage view became visible: refetch usage; for providers in state "ready" whose plan limits are `idle` or older than 60 s, call refreshPlanLimits(id, false). */
  shown(): void;
  /** Called on every state push: provider names and states (enables or disables Refresh, labels). */
  setState(state: StateView): void;
}
export function initUsageView(deps: UsageViewDeps): UsageViewHandle;
```

`initUsageView` wires the buttons, subscribes `api.onUsage`, loads `api.getUsage()` and `api.getPlanLimits()`, renders the Overview strip and the Usage view. No timers. All text through `textContent`; sizes through CSSOM (`node.style.height = "42%"`), never `setAttribute("style")`.

Markup contract (T5 writes it inside `#view-usage`; T6 only fills the empty containers):

```html
<div class="view-head"><div><h1 id="usage-title">Usage</h1><p class="view-sub">What went through this proxy, and how much of each plan is left.</p></div></div>
<section class="card" id="usage-proxy">
  <div class="card-head"><h2>Counted by the proxy</h2>
    <div class="segmented" id="usage-range" role="group" aria-label="Range">
      <button type="button" data-range="today">Today</button><button type="button" data-range="last7">7 days</button><button type="button" data-range="last30">30 days</button><button type="button" data-range="allTime">All time</button>
    </div>
    <button type="button" id="usage-reset" class="small quiet-danger push">Reset usage</button>
  </div>
  <div class="stats" id="usage-stats"></div>
  <div class="table-wrap"><table class="table" id="usage-table"><thead><tr><th>Provider</th><th>Requests</th><th>Errors</th><th>Input tokens</th><th>Output tokens</th></tr></thead><tbody id="usage-body"></tbody><tfoot id="usage-foot"></tfoot></table></div>
  <div class="chart-head"><h3>Last 30 days</h3>
    <div class="segmented" id="usage-metric" role="group" aria-label="Chart metric"><button type="button" data-metric="requests">Requests</button><button type="button" data-metric="tokens">Tokens</button></div>
  </div>
  <div class="chart" id="usage-chart" role="img" aria-label="Requests per day, last 30 days"></div>
  <ul class="legend" id="usage-legend"></ul>
  <p class="note" id="usage-note"></p>
</section>
<section class="card" id="usage-limits">
  <div class="card-head"><h2>Plan limits</h2><button type="button" id="limits-refresh-all" class="small push">Refresh all</button></div>
  <div class="limits-grid" id="limits-list"></div>
  <p class="note">Read from the agents on demand (Codex: /status, Claude: /usage) and cached for a minute. Limits are shared with your other tools, so they change without proxy traffic.</p>
</section>
```

Behaviour:
- **Range** (default `today`; remembered in `localStorage["acp-proxy.usageRange"]`, try/catch): `aria-pressed` on the active button. `#usage-stats` shows four `.stat` tiles for the selected range of `total`: Requests; Input tokens; Output tokens; Errors (sub: error rate %). Token values compact (`Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })`), full number in `title`. When `estimated > 0` in the range, the token values get the `.approx` "≈ " prefix and the tile `title` says "N of M requests have estimated token counts (about 4 characters per token)".
- **Table**: one row per provider of `UsageView.providers` in the order Codex, Claude, Antigravity, then others; first cell a `.legend-swatch.series-<id>` (`series-other` for unknown ids) + the provider name from the state (fallback id); numbers in `td.num`, full with grouping; rows with zero requests get `.is-zero` (muted). `#usage-foot` holds the `tr.total` row. "≈" as above per cell.
- **Chart**: 30 `.chart-day` columns from `days`; each a vertical stack of `.chart-seg.series-<id>` with height = share of the max day total (requests, or input + output tokens for the Tokens metric) in percent via CSSOM; `title` per column: "<weekday, day month> · Codex 12 · Claude 3" (or tokens). Under the columns a `.chart-axis` row with labels for the first day, every 7th day back from today, and "Today". All zero -> `.empty-state` "No requests in the last 30 days." in place of the columns. `#usage-legend` lists the providers with swatches. Metric remembered in `localStorage["acp-proxy.usageMetric"]`.
- **Note** (`#usage-note`): "Counted by this proxy since <since, localized date>. Recent requests' Clear does not change these totals. ≈ marks estimates (about 4 characters per token) for answers where the agent reported no usage." (No "since" part when `since` is absent.)
- **Reset**: `#usage-reset` opens `#reset-usage-dialog` (`showModal`; Esc = cancel through `oncancel`); Confirm calls `api.resetUsage()`; a failed result shows its message in `#usage-note` styled `.msg.bad`; the push renders the zeros.
- **Plan limits**: one `.limit-card` per provider in the order Codex, Claude, Antigravity (from `getPlanLimits()` and later results). Card head: provider name, a `.badge` (ok "current" / warn "near limit" when any window >= 75 / err "limit reached" when any >= 100 or the hint status is `rejected` / neutral otherwise), the plan, and a `Refresh` `.small` button (`refreshPlanLimits(id, true)`; while pending: disabled, "Checking…"). Body by state:
  - `ok`: one `.limit-window` per window: label, `.meter` with `.meter-fill` width `usedPercent%` (CSSOM) and class `is-warn` (>= 75) / `is-err` (>= 90), "34% used", "Resets <resetText>" when present. Then "Checked at <HH:MM>" (from `fetchedAt`) and `credits` when present.
  - `idle`: "Not checked yet." (Refresh enabled when the provider state is `ready` or `stopped`).
  - `no_data`: "The agent has no plan limits for this account (an API key login has none)." plus the plan.
  - `unparsed`: "Could not read the agent's answer. Here it is as the agent sent it:" + `<details open><summary>Answer</summary><pre class="limit-raw">` raw `</pre></details>`.
  - `unsupported` / `unavailable` / `error`: the `message` (Antigravity: "Plan limits are not available for this provider."), Refresh hidden for `unsupported`.
  - `needs_login`: the message + a `.link-button` "Open <name>" that calls `showView(id)`.
  - `hint` (Claude): a line "Claude reported at <HH:MM>: <type label> <status text>[, <utilization>% used][, resets <time>]" with `five_hour` -> "5-hour window", `seven_day` -> "weekly window", others as is; status `allowed_warning` -> "near the limit", `rejected` -> "limit reached", `allowed` -> "within the limit".
  - `#limits-refresh-all` refreshes every supported provider with state `ready` (force).
- **Overview strip** (`#ov-usage`): three `.stat` tiles for `total.today`: Requests, Tokens (input + output, ≈ when estimated), Errors; `#ov-usage-open` calls `showView("usage")`.
- `usage.css` uses only the tokens and shared components of `settings.css`, plus its own classes: `.chart-head`, `.chart`, `.chart-day`, `.chart-seg`, `.chart-axis`, `.legend`, `.legend-swatch`, `.series-codex` / `-claude` / `-antigravity` / `-other` (background from the series tokens), `.limits-grid` (`repeat(auto-fit, minmax(260px, 1fr))`), `.limit-card`, `.limit-head`, `.limit-window`, `.meter` (8 px track on `--surface-2`, `--radius-sm`), `.meter-fill` (accent; `.is-warn` warn, `.is-err` err), `.limit-meta`, `.limit-raw` (mono, `--text-xs`, max-height 200 px, scroll, pre-wrap), `.is-zero`. Chart height 140 px; columns `flex: 1` with 2 px gaps; segment corners only on the top segment.

### T7. Docs (`README.md`, `ROADMAP.md`)

- **Recent requests** paragraph (README ~:41): keep "in memory only" for the list; add that it is now on the **Requests** page, and that **Clear** does not change the usage totals.
- New paragraph **Usage** after it: the Usage page shows per provider requests, errors, input and output tokens for today, 7 days, 30 days and all time, a bar chart of the last 30 days, and the totals of all providers; counted by the proxy for every request that reached a provider (failed ones count as errors), from the HTTP API and the MCP endpoint; "≈" marks chars/4 estimates when the agent reported no usage; stored in `usage.json` (day buckets kept 400 days, all-time totals kept until reset); the headless CLI records too; **Reset usage** asks first and cannot be undone; the Overview shows today's numbers.
- New paragraph **Plan limits**: Codex through `/status`, Claude through `/usage`, sent in a throwaway agent session only when you press Refresh (or open the Usage page, for a provider that is ready and whose value is older than a minute); never on a timer. The probe takes a slot of the provider's [concurrency cap](#concurrency-cap), is not listed in Recent requests and not counted in the totals, and does not run while the provider needs login. Codex reports "% left", shown as used. Claude also pushes rate-limit hints after requests, shown under its card. Antigravity: not available. A custom `PROXY_ACP_COMMAND` Codex adapter: not available. API key logins have no plan limits. The account email and session cost from these answers are never logged or shown; when an answer cannot be read, it is shown as sent with those parts removed. The answers' wording is not a stable contract of the adapters (codex-acp 2.3.0, claude-agent-acp 0.91.0).
- **Settings window** paragraph and the **Overview** paragraph: describe the sidebar (Overview, Usage, Requests, Server, Codex, Claude, Antigravity; logs folder, settings path and secrets note at the bottom of the sidebar), light and dark following Windows, unsaved-changes dot on a page; "Overview (top of the settings window)" -> "Overview page"; "provider card" -> "provider page" where the text means the window.
- **Files** table: row `usage.json` | "Request and token totals per provider and day (see Usage)".
- `ROADMAP.md`: an `[x]` line under "Limits seen from the hub" or a new short "Window" line: "Usage per provider (persisted totals, plan limits for Codex and Claude) and a redesigned settings window with a sidebar. (AAP-29)".

## Acceptance criteria and proofs

| # | Criterion | Proof |
| --- | --- | --- |
| A1 | Totals per provider and local day count requests, errors, input/output tokens and estimates; ranges today / 7 / 30 / all time and the 30-day series are right; entries without provider are ignored | `tests/usage-store.test.ts` test 1 |
| A2 | Totals survive a restart (atomic `usage.json`), days older than the retention are pruned while all-time stays, a broken file does not crash | `tests/usage-store.test.ts` test 2 |
| A3 | Reset zeroes the totals and the file | `tests/usage-store.test.ts` test 3; app: Reset usage with the dialog (A12) |
| A4 | A request through the controller is counted, and Clear of Recent requests leaves the totals alone | Edited test in `tests/controller.test.ts` |
| A5 | Estimated token counts are flagged (`estimated: true`) in the activity entry | Covered by A1's input shape plus typecheck; app: "≈" visible in Requests for an agent without usage reports (UNTESTED unless seen in the app) |
| A6 | Codex `/status` and Claude `/usage` are parsed into used percentages, plan and reset text; no-data and unknown texts are handled; the email and cost never survive | `tests/plan-limits.test.ts` tests 1 and 2 |
| A7 | The probe sends only the slash command in a throwaway session (no preamble, no model), is not in the activity log or the totals, is cached for 60 s, is not run while the provider needs login; Antigravity is unsupported | `tests/plan-limits.test.ts` test 3 |
| A8 | The probe takes a concurrency slot | Code review of `router.probePlanLimits` (no test: the limiter itself is tested in `tests/limiter.test.ts`) |
| A9 | The real Codex and Claude adapters answer `/status` and `/usage` through the proxy and the Usage page shows their windows | App only: Usage page, Refresh on Codex and Claude with real logins. UNTESTED until run (research marks this as inferred) |
| A10 | The headless CLI writes `usage.json` | Manual: `fnm exec --using default npm run build`, `node dist/index.js` with `PROXY_SETTINGS_FILE` in a temp folder, one chat request with curl, Ctrl+C, `usage.json` has one request |
| A11 | Both tsconfigs compile; the full suite passes (baseline 736 passed, 2 skipped, plus the new tests) | Verification commands below |
| A12 | The window has the sidebar with the seven views, every item of the T5 feature checklist works, the Usage page and the Overview strip render, the reset dialog works, light and dark both look right, the layout holds at 640x480 | App only: `app:dev` with `ACP_PROXY_DEV_DIR` (`dump`, `shot`, `eval.js`) for each view; dark mode by switching Windows to dark and taking a second set of shots. UNTESTED until run |
| A13 | No CSP violation, no inline style or handler | `grep -n "style=\|onclick=\|<style" src/renderer/*.html` empty; no `setAttribute("style"` in `src/renderer`; renderer console has no CSP errors in the app log (`[renderer ...]` lines) |
| A14 | README and ROADMAP describe the new behaviour | Read-through against T7 |

## Verification

From the repo root:

1. `fnm exec --using default node node_modules/typescript/bin/tsc --noEmit`
2. `fnm exec --using default node node_modules/typescript/bin/tsc --noEmit -p tsconfig.renderer.json`
3. `fnm exec --using default node node_modules/vitest/vitest.mjs run` (expect 736 + new tests passed, 2 skipped)
4. `fnm exec --using default npm run build`
5. App check (A9, A12, A13): `ACP_PROXY_DEV_DIR=<repo>/.claude/temp/devctl fnm exec --using default npm run app:dev`; per view: `eval.js` with `document.querySelector('[data-view="usage"]').click()` (and the others), then `shot`; check the T5 checklist by hand.

## Risks

- The `/status` and `/usage` wording is not a contract and the Claude usage API is experimental: parsers degrade to `unparsed` with the redacted raw text; pin the adapter versions as they are.
- That the slash commands work through this proxy's prompt path is inferred, not tested (A9). If they do not, the card shows `error` or `unparsed`; nothing else breaks.
- A Codex slash-command session may leave a persisted thread in the Codex home (unverified); acceptable, same home the proxy already uses.
- Claude's hint `utilization` unit (0-1 or 0-100) and `resetsAt` unit are not documented; the reader guesses by magnitude.
- Writing `usage.json` on Windows: rename EPERM/EBUSY handled by retry; writes are coalesced (2 s).
- The redesign touches every control: the id-preservation list in T5 and the checklist are the guard; do not rename ids or `data-role` values.

## Implementation status (2026-11-09, implement)

- [x] T1 shared types (orchestrator)
- [x] T2 usage store, estimated flag, controller wiring
- [x] T3 plan-limit probe and parsers
- [x] T4 IPC wiring
- [x] T5 renderer shell and existing views
- [x] T6 Usage view
- [x] T7 README and ROADMAP
- Verification: both tsc clean; vitest 742 passed, 2 skipped (736 + 6 new); build (tsc, tsc renderer, copy-static) ok; CSP greps empty.
- App check: all seven views, the plan-limits card and the reset dialog screenshotted in dark (system theme) and light (dark media rules removed in the page for the shot) with all providers off. Not checked: real Codex/Claude probes (A9), the 640x480 layout, chart with data, interactive checklist items beyond navigation and the reset dialog.
- Deviations: `npm run build` ran as its three steps (npm is not on PATH through fnm here); see changelog.md.
