# AAP-31 task 1 notes: how the bundled Codex adapter reports a usage limit

Read: `node_modules/@agentclientprotocol/codex-acp/dist/index.js` (35505-35520, 36310-36340, 36454-36465, 51015-51065, 51300-51330, 51428-51440) and the rollout logs in `%APPDATA%\api-acp-proxy\codex-home\archived_sessions\rollout-2026-11-15T14-3*.jsonl` (read only, nothing copied).

## Path taken for a non-AIR client (the proxy sends `clientCapabilities: {}`)

**Path A is real, path B is not needed.** The event handler (36310-36335): with no typed-session-failure support, for `codexErrorInfo === "usageLimitExceeded"` it sets
`this.failure = RequestError.internalError(createTurnErrorData(error))` and returns an `agent_message_chunk` with the readable message. The prompt handler then throws that failure (51320-51323 for command turns, 51432-51435 for normal turns). So the order on the wire is: the message streamed as agent text first, then the `session/prompt` request fails.

Error shape (JSON-RPC -32603 "Internal error"), `createTurnErrorData` (36454-36465):

```
data: { message: <additionalDetails ?? message>, codexErrorInfo: "usageLimitExceeded", additionalDetails?: <string> }
```

The v2 path (51015-51065) is for post-insertion failures of the other prompt kind; it does not carry `usageLimitExceeded` as an `end_turn`. No `session_info_update` matcher or text-only matcher was added.

Consequence: text may already have been streamed when the error comes (not taken back, out of scope per the plan).

## Reset text formats seen in the logs

Only one, six occurrences, all the same message:

`You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 29th, 2026 11:07 AM.`

So: month abbreviation, day with ordinal suffix, comma, year, 12-hour time with AM/PM, no zone (14:33 local = 13:33Z on 2026-11-15, so the time is local). No time-only form was seen; the parser still accepts it as the plan says.
