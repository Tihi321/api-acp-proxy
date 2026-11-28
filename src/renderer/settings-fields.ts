export type Scope = "server" | "codex" | "antigravity" | "claude" | "gufo" | "strata" | "llama" | "ollama" | "deepseek";
export interface FieldSpec { path: string; kind: "text" | "number" | "bool" | "select"; scope: Scope; optional?: boolean }

export const fields: FieldSpec[] = [
  { path: "server.host", kind: "text", scope: "server" },
  { path: "server.port", kind: "number", scope: "server" },
  { path: "server.apiKey", kind: "text", scope: "server", optional: true },
  { path: "server.timeoutMs", kind: "number", scope: "server" },
  { path: "server.maxBodyBytes", kind: "number", scope: "server" },
  { path: "server.modelsWaitMs", kind: "number", scope: "server" },
  { path: "server.toolResultTimeoutMs", kind: "number", scope: "server" },
  { path: "server.maxConcurrent", kind: "number", scope: "server" },
  { path: "server.maxQueue", kind: "number", scope: "server" },
  { path: "server.launchAtLogin", kind: "bool", scope: "server" },
  { path: "server.reuseSessions", kind: "bool", scope: "server" },
  { path: "server.listBareAliases", kind: "bool", scope: "server" },
  { path: "providers.codex.enabled", kind: "bool", scope: "codex" },
  { path: "providers.codex.maxConcurrent", kind: "number", scope: "codex", optional: true },
  { path: "providers.codex.maxPromptChars", kind: "number", scope: "codex", optional: true },
  { path: "providers.codex.authMethodId", kind: "select", scope: "codex", optional: true },
  { path: "providers.codex.isolatedHome", kind: "bool", scope: "codex" },
  { path: "providers.antigravity.enabled", kind: "bool", scope: "antigravity" },
  { path: "providers.antigravity.maxConcurrent", kind: "number", scope: "antigravity", optional: true },
  { path: "providers.antigravity.maxPromptChars", kind: "number", scope: "antigravity", optional: true },
  { path: "providers.antigravity.authMethodId", kind: "select", scope: "antigravity", optional: true },
  { path: "providers.antigravity.executablePath", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.apiKey", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.geminiHome", kind: "text", scope: "antigravity", optional: true },
  { path: "providers.antigravity.purgeSessions", kind: "bool", scope: "antigravity" },
  { path: "providers.claude.enabled", kind: "bool", scope: "claude" },
  { path: "providers.claude.maxConcurrent", kind: "number", scope: "claude", optional: true },
  { path: "providers.claude.maxPromptChars", kind: "number", scope: "claude", optional: true },
  { path: "providers.claude.authMethodId", kind: "select", scope: "claude", optional: true },
  { path: "providers.claude.apiKey", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.oauthToken", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.configDir", kind: "text", scope: "claude", optional: true },
  { path: "providers.claude.executablePath", kind: "text", scope: "claude", optional: true },
  { path: "providers.gufo.enabled", kind: "bool", scope: "gufo" },
  { path: "providers.gufo.port", kind: "number", scope: "gufo" },
  { path: "providers.gufo.command", kind: "text", scope: "gufo" },
  { path: "providers.gufo.cwd", kind: "text", scope: "gufo" },
  { path: "providers.gufo.apiKey", kind: "text", scope: "gufo", optional: true },
  { path: "providers.gufo.maxConcurrent", kind: "number", scope: "gufo", optional: true },
  { path: "providers.strata.enabled", kind: "bool", scope: "strata" },
  { path: "providers.strata.port", kind: "number", scope: "strata" },
  { path: "providers.strata.command", kind: "text", scope: "strata" },
  { path: "providers.strata.args", kind: "text", scope: "strata", optional: true },
  { path: "providers.strata.cwd", kind: "text", scope: "strata" },
  { path: "providers.strata.apiKey", kind: "text", scope: "strata", optional: true },
  { path: "providers.strata.maxConcurrent", kind: "number", scope: "strata", optional: true },
  { path: "providers.ollama.enabled", kind: "bool", scope: "ollama" },
  { path: "providers.ollama.baseUrl", kind: "text", scope: "ollama" },
  { path: "providers.ollama.apiKey", kind: "text", scope: "ollama", optional: true },
  { path: "providers.ollama.maxConcurrent", kind: "number", scope: "ollama", optional: true },
  { path: "providers.ollama.maxPromptChars", kind: "number", scope: "ollama", optional: true },
  { path: "providers.deepseek.enabled", kind: "bool", scope: "deepseek" },
  { path: "providers.deepseek.baseUrl", kind: "text", scope: "deepseek" },
  { path: "providers.deepseek.apiKey", kind: "text", scope: "deepseek", optional: true },
  { path: "providers.deepseek.maxConcurrent", kind: "number", scope: "deepseek", optional: true },
  { path: "providers.deepseek.maxPromptChars", kind: "number", scope: "deepseek", optional: true },
  { path: "providers.llama.enabled", kind: "bool", scope: "llama" },
  { path: "providers.llama.port", kind: "number", scope: "llama" },
  { path: "providers.llama.maxConcurrent", kind: "number", scope: "llama", optional: true },
  { path: "providers.llama.modelsDir", kind: "text", scope: "llama" },
  { path: "providers.llama.hfToken", kind: "text", scope: "llama", optional: true },
  { path: "providers.llama.embedding.enabled", kind: "bool", scope: "llama" },
  { path: "providers.llama.embedding.port", kind: "number", scope: "llama" },
  { path: "providers.llama.embedding.ctxSize", kind: "number", scope: "llama" },
];

/** The patch value of one text or number field from its raw input text, or the error shown under it. Empty optional -> null (the key is cleared, the schema default applies). Pure. */
export function fieldValue(spec: FieldSpec, raw: string): { value: string | number | null } | { error: string } {
  if (spec.kind === "number") {
    if (raw.trim() === "") return spec.optional ? { value: null } : { error: "Required" };
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { error: "Must be a number" };
  }
  const text = spec.path.endsWith("apiKey") ? raw : raw.trim();
  if (text === "") return spec.optional ? { value: null } : { error: "Required" };
  return { value: text };
}
