// Pure helpers of the playground page (no DOM), so they can be tested on their own.

export interface ModelGroup { provider: string; models: string[] }

/**
 * The ids of `/v1/models` grouped by provider prefix (`codex/…`, `antigravity/…`). An unprefixed id that is also listed as `<provider>/<id>` is
 * shown once, prefixed (unambiguous); one without a prefixed twin goes to "other". Groups and ids keep the order of the list.
 */
export function groupModels(ids: readonly string[]): ModelGroup[] {
  const prefixed = new Set(ids.filter((id) => id.includes("/")).map((id) => id.slice(id.indexOf("/") + 1)));
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.indexOf("/");
    if (slash < 0 && prefixed.has(id)) continue;
    const provider = slash > 0 ? id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    if (!list.includes(id)) list.push(id);
    groups.set(provider, list);
  }
  return [...groups].map(([provider, models]) => ({ provider, models }));
}

/** Splits received SSE text into the `data:` payloads of complete lines; `rest` is the unfinished last line to prepend to the next chunk. */
export function parseSseLines(buffer: string): { events: string[]; rest: string } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const events = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
  return { events, rest };
}

/** A curl command for the request (bash quoting). The key is never put in: `$ACP_PROXY_KEY` stands for it when the proxy needs one. */
export function curlFor(baseUrl: string, body: unknown, withKey: boolean): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const lines = [`curl ${quote(`${baseUrl}/chat/completions`)}`, `  -H 'Content-Type: application/json'`];
  if (withKey) lines.push(`  -H "Authorization: Bearer $ACP_PROXY_KEY"`);
  lines.push(`  -d ${quote(JSON.stringify(body))}`);
  return lines.join(" \\\n");
}

/** The history title of a chat: its first message on one line, cut to `max` characters. */
export function chatTitle(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "850 ms", "3.2 s", "1 min 5 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Only http(s) links are shown as links. */
export function isHttpUrl(url: string): boolean {
  try { const { protocol } = new URL(url); return protocol === "http:" || protocol === "https:"; } catch { return false; }
}
