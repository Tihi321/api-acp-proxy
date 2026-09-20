import readline from "node:readline";
let pendingPrompt;
const sent = [];
const send = (value) => { sent.push(value); process.stdout.write(JSON.stringify(value) + "\n"); };
const finish = (id, reason = "end_turn") => send({ jsonrpc: "2.0", id, result: { stopReason: reason, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } });
const promptDone = (id) => {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake response" } } } });
  finish(id);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line); const { id, method, params = {} } = message;
  if (!method) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: true } }, agentInfo: { name: "fake", version: "1" } } });
  else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: "fake-session", modes: { currentModeId: "read-only", availableModes: [{ id: "read-only", name: "Read only" }] }, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol" }, { value: "gpt-5.6-terra" }, { value: "gpt-5.6-luna" }] }] } });
  else if (method === "session/set_config_option" || method === "session/set_mode" || method === "session/delete") send({ jsonrpc: "2.0", id, result: { configOptions: [] } });
  else if (method === "session/cancel") { if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = undefined; finish(p, "cancelled"); } }
  else if (method === "session/prompt") {
    pendingPrompt = id;
    const run = () => {
      if (!pendingPrompt) return;
      if (process.env.FAKE_ACP_REQUIRE_PERMISSION === "1") send({ jsonrpc: "2.0", id: 9001, method: "session/request_permission", params: { sessionId: "fake-session", toolCall: { toolCallId: "tool", title: "run command", kind: "execute", status: "pending", content: [] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } });
      setTimeout(() => { if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = undefined; promptDone(p); } }, 20);
    };
    if (process.env.FAKE_ACP_DELAY === "1") setTimeout(run, 500); else run();
  }
});
