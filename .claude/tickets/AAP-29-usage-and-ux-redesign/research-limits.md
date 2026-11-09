# AAP-29 research: reading account plan limits per provider

## Question
Can the proxy read each provider's account plan limits / quota usage (Codex 5h/weekly, Claude 5h/weekly, Antigravity quota), and how?

## Answer
- Codex: AVAILABLE on demand, but only as markdown text via the `/status` slash command (codex-acp 2.3.0). The structured data (app-server `account/rateLimits/read`, `account/rateLimits/updated`) is NOT forwarded as structured ACP data.
- Claude: AVAILABLE. Two routes: (a) pushed `usage_update` session updates with `_meta["_claude/rateLimit"]` after a request (partial: one window per event); (b) on demand, prompt `/usage`, which returns markdown built from the SDK `get_usage` response (full 5h / weekly / per-model windows). Neither gives raw JSON through ACP.
- Antigravity: NOT AVAILABLE via ACP (no evidence of any quota method or field). The bundled `localharness_external.exe` contains `retrieveUserQuota`, a remote Google endpoint: undocumented, risky, not recommended.
- Recommended: parse the markdown of `/status` (Codex) and `/usage` (Claude) from a dedicated throwaway session, cache it, refresh on demand/interval. Antigravity: show "unavailable"; fall back to counting the proxy's own tokens and to 429/quota errors.
- Nothing was run against live agents (no login, no agent start): all findings are from reading dist code and binary strings. That `/status` and `/usage` work through this proxy's prompt path is **inferred**, not tested.

## Path through the code

### Codex (`@agentclientprotocol/codex-acp` 2.3.0, bundles `@openai/codex` ^0.164)
Paths below are relative to node_modules/@agentclientprotocol/codex-acp/dist.
- codex-acp runs a Codex app-server and talks JSON-RPC to it. `getRateLimits()` calls `accountRateLimitsRead()` -> request `account/rateLimits/read` (index.js:39868, 41694). **confirmed**
- It also receives the notification `account/rateLimits/updated` and merges it into `sessionState.rateLimits` (index.js:35934-35935, 36494-36505). **confirmed** (when Codex pushes it: inferred)
- codex-acp never sends these to the ACP client as structured data: grep of index.js finds no `_meta` or `usage_update` carrying rate limits; its `usage_update` is context/tokens only. The only outlet is the slash command `/status` (command list index.js:43842-43845 "Display session configuration and token usage"; handler index.js:43990-43996: `refreshRateLimits` (calls `account/rateLimits/read`, index.js:44142-44150), then `buildStatusMessage` sent as one `agent_message_chunk`, returns `handled: true`). **confirmed**
- Markdown format (index.js:44112-44136, 44187-44235), lines joined with two spaces + newline:
  - `**Limits:** data not available yet` when none (same text if the refresh failed; failure only logged).
  - per limit snapshot: `**<limitName> <label>:** <N>% left (resets HH:MM[ on D Mon])`. Label from `windowDurationMins`: `<n>m limit`, `<n>h limit` (<1440 min), `<n>d limit` (<10080), else `Weekly limit`; primary and secondary windows (typically 5h + weekly). It reports % LEFT (100 - usedPercent, rounded). Reset time is local time of the agent process, no timezone, no year.
  - `**<name> Credits:** unlimited | <balance>`; `**<name> individual spend limit:** N% left (X of Y credits used; resets Mon D)`.
  - `**Account:** ChatGPT <planType> (<email>)` or `API key configured` (index.js:44164-44178). Contains the email: do not log or expose it.
- Underlying snapshot shape (inferred from the code that reads it, index.js:34799-34825, 44197-44230): `{ limitId, limitName, primary:{usedPercent, windowDurationMins, resetsAt (epoch seconds)}, secondary:{same}, credits:{unlimited, balance}, individualLimit:{used, limit, remainingPercent, resetsAt}, planType, spendControlReached }`, plus a `rateLimitsByLimitId` map in the read response. Exact types live in the codex binary's generated protocol types (not inspected).
- Freshness: `/status` triggers a fresh read each time (confirmed). No model call: the handler returns before any turn starts (inferred).
- API-key logins: plan limits are a ChatGPT-plan feature; with an API key the Limits line probably says "not available yet" (inferred).
- Option B (non-ACP): run a second `codex app-server` (binary in node_modules/@openai/codex-win32-x64) with the same `CODEX_HOME` and call `account/rateLimits/read` over stdio JSON-RPC, giving structured JSON. Local and uses the official protocol, but a second process, its own `initialize` handshake, and a possible race on token refresh of the shared auth.json. Not tested.

### Claude (`@agentclientprotocol/claude-agent-acp` 0.91.0 over `@anthropic-ai/claude-agent-sdk`)
Paths relative to node_modules/@agentclientprotocol/claude-agent-acp/dist; SDK = node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts.
- Push route: the SDK emits `rate_limit_event` ("when rate limit info changes", SDK:5711-5718, shape 5724-5752). claude-agent-acp forwards it as `usage_update` with `_meta: { "_claude/rateLimit": message.rate_limit_info }` (acp-agent.js:5782-5793). **confirmed**
  - Only forwarded when `lastAssistantTotalUsage !== null`, i.e. after at least one assistant message in the session, otherwise silently dropped (acp-agent.js:5783). So: available after a request.
  - `rate_limit_info`: `status: 'allowed'|'allowed_warning'|'rejected'`, `resetsAt?` (number; unit not stated), `rateLimitType?: 'five_hour'|'seven_day'|'seven_day_opus'|'seven_day_sonnet'|'seven_day_overage_included'|'overage'`, `utilization?` (number; 0-1 or 0-100 not stated), `surpassedThreshold?`, overage fields. One event = one window, emitted when info changes, so not a full snapshot. Doc says "for claude.ai subscription users".
- On-demand route: prompt text exactly `/usage` as the only text block (acp-agent.js:2037-2051 `localCommandMarkdown`; `isUsageCommandText` is `text.trim() === "/usage"`, usage-markdown.js). The agent calls `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (SDK control request `get_usage`, SDK:4285-4330) with a timeout, then renders `formatUsageResponse` markdown (usage-markdown.js:~88-140). On timeout or incompatible shape it forwards Claude Code's own `/usage` text (acp-agent.js:143-170). **confirmed**
  - Markdown: `## Usage`, `> Claude <pro|max|team|enterprise> subscription usage`, `### Limits`, then per window `**5-hour limit** — **34%** · Resets Nov 8, 3:00 PM GMT+1` plus a 20-cell bar line; windows: `5-hour limit`, `Weekly · all models`, per-model `Weekly · <display_name>` (or Opus/Sonnet). Value is percent USED. Window omitted when utilization is null. Also session cost/behaviour sections.
  - Underlying structured response (SDK:4296-4350): `{ session:{total_cost_usd, ..., model_usage}, subscription_type, rate_limits_available, rate_limits:{ five_hour:{utilization 0-100, resets_at ISO8601}, seven_day, seven_day_opus, seven_day_sonnet, model_scoped:[{display_name,utilization,resets_at}], extra_usage:{is_enabled,monthly_limit,used_credits,utilization,currency} }, behaviors }`. `skip_behaviors` exists in the SDK request but the ACP layer does not pass it. Only the markdown reaches the ACP client. A "structured twin" `SDKUsageReport` exists (SDK:6270) but claude-agent-acp does not seem to forward it (inferred; not exhaustively checked).
  - Per the SDK docs the data comes from the claude.ai usage endpoint, called by the Claude CLI with the user's own login: the official client path, not a call made by the proxy. `rate_limits_available` is false for API key / Bedrock / Vertex.
- Terminal failures carry quota info: session-failure-extension.js:64-69, 331-349 map quota exhaustion to `quota_exhausted` / `rate_limited`. `_meta.quota` on prompt responses is the turn's TOKEN counts (acp-agent.js:8824-8850), not plan limits. **confirmed**
- Freshness: `/usage` fetches on each call; `_claude/rateLimit` is as of the last event. The SDK method is experimental ("MAY_CHANGE").

### Antigravity (`agy_acp_server` 1.4.3, `%APPDATA%\api-acp-proxy\agents\antigravity-acp\1.4.3`)
- Repo: `src/providers/antigravity.ts` handles install, auth, session purge, image/search permissions and `mapError`. grep for quota/rate_limit/usage_update in src finds only `src/api.ts:122` (429 error type) and `src/playground/playground.ts:33` (browser quota). No limits handling. **confirmed**
- Binary strings (read-only `grep -a`): `agy_acp_server.exe` has only `...acp_server.ccpa_connection.quota_errors` (error mapping). `localharness_external.exe` has `retrieveUserQuota`, `retrieveUserQuotaSummary`, `quotaBuckets`, `quotaBucketKey/Name/Team`, `remainingFraction`, `isHardQuotaExhaustedMessage`. **confirmed** that the strings exist; their meaning is **inferred**: a remote Google call with the user's OAuth token, internal to the harness, not exposed over ACP.
- Local files listed: `~/.gemini/antigravity-acp/` (`acp_token.json`, `settings.json`, `conversations`, `brain`), `~/.gemini/antigravity-cli/cache/` (`conversation_metadata.json`, `default_project_id.txt`, `last_conversations.json`, `onboarding.json`). No quota file by name; contents not read (token file).
- Verdict: not available through a supported interface. Calling `retrieveUserQuota` ourselves = undocumented remote endpoint plus the user's token: RISKY, not recommended. Unknown whether the server sends any quota `_meta` / `usage_update` during a session; needs a live trace.

## Reproduction
Not applicable (research). No agent was started; no `/status` or `/usage` prompt was run. Smallest test for the plan: with logins in place send `/status` to a Codex session and `/usage` to a Claude session through `AcpProvider` and print the `agent_message_chunk` text; for Antigravity log every `sessionUpdate` kind and `_meta` key of a normal request.

## What the plan needs
- Files: `src/acp-provider.ts` (session creation ~:531, update handlers ~:727 and ~:840; keeps only message chunks and tool calls and ignores `usage_update`), `src/providers/{codex,claude,antigravity}.ts` (descriptors: add an optional limits hook + parser), `src/provider.ts` (descriptor interface), `src/controller.ts` / `src/usage.ts` (store and expose), `src/renderer` (UI).
- A limits probe: create or reuse a session, send the slash command as the only text block (not through `promptPreamble`), collect `agent_message_chunk` text until the prompt resolves, discard the session; do not take a request slot unfairly (limiter.ts); not recorded for Antigravity session purge.
- Parsers: Codex regex on `**...limit:** N% left (resets ...)` (LEFT, local time without tz); Claude regex on `**<label>** — **N%**` and `Resets ...` (USED, tz abbreviation, no year). Degrade to "unknown" and keep the raw text.
- Passive capture at no cost: keep `usage_update._meta["_claude/rateLimit"]` as a warning hint (status allowed_warning/rejected, rateLimitType, utilization, resetsAt).
- Data shape suggestion: `{ provider, fetchedAt, source: "status"|"usage"|"event", plan?, windows:[{label, usedPercent, resetsAt?, windowMins?}], credits?, raw? }`. Normalise left vs used.
- Tests: existing ones not examined; a fake ACP agent answering `/status` and `/usage` markdown is needed.

## Risks
- Both routes depend on markdown wording that is not a contract; Claude's underlying API is explicitly experimental. Pin versions, test parsers on recorded samples, fall back to raw text.
- Slash commands are specific to these two adapters; a custom adapter via `PROXY_ACP_COMMAND` may not support them.
- Codex `/status` contains the account email; Claude `/usage` contains session cost. Keep out of logs and the activity log.
- Probe sessions cost process work, and a Codex slash-command turn may still create a persisted thread (inferred; unverified).
- Limits are plan-wide and shared with the user's other tools, so they change without proxy traffic: cache briefly (suggest >= 60 s), refresh when the UI opens.
- API-key setups have no plan limits: UI must show "not applicable".
- Antigravity: no sanctioned way; do not call `retrieveUserQuota`.

## Open questions
1. Value domain of Claude `utilization` and unit of `resetsAt` in `rate_limit_event`.
2. Do `/status` and `/usage` work through this proxy's session/prompt path and its sandbox settings (not run)?
3. Does a Codex slash-command turn create a persisted thread, and does it need a model?
4. Does `agy_acp_server` emit any quota `_meta` / `usage_update` or extension methods (live trace needed)?
5. Exact Codex `RateLimitSnapshot` TypeScript type (in the codex binary protocol, not inspected).
