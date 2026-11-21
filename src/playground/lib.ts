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

export type Block = { type: "text"; text: string } | { type: "code"; lang: string; code: string; closed: boolean };

/**
 * Splits text at ``` / ~~~ fences (fence line: up to 3 spaces, 3+ backticks or tildes, optional info string; `lang` = first word of it, lower-cased, "" if none).
 * A fence closes on a line of the same char, at least as long, nothing but spaces after. An unclosed last fence gives `closed: false`. Empty text blocks are left out.
 */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let prose: string[] = [];
  let open: { char: string; length: number; lang: string; lines: string[] } | undefined;
  const flushText = () => {
    const joined = prose.join("\n");
    if (joined.trim()) blocks.push({ type: "text", text: joined });
    prose = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close?.[1] && close[1][0] === open.char && close[1].length >= open.length) {
        blocks.push({ type: "code", lang: open.lang, code: open.lines.join("\n"), closed: true });
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
    if (fence?.[1]) {
      flushText();
      open = { char: fence[1][0] ?? "`", length: fence[1].length, lang: (fence[2] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "", lines: [] };
    } else prose.push(line);
  }
  if (open) blocks.push({ type: "code", lang: open.lang, code: open.lines.join("\n"), closed: false });
  else flushText();
  return blocks;
}

/**
 * One HTML document from the closed code blocks of one message: html|htm blocks joined, css as <style>, js|javascript|mjs as <script> (each `</script` / `</style` escaped as `<\/script` / `<\/style`).
 * If an html block has </head> / </body>, styles / scripts go before them; otherwise the parts are wrapped in `<!doctype html><html><head><meta charset="utf-8">…</head><body>…</body></html>`. undefined when there is no such block.
 */
export function previewDocument(blocks: readonly Block[]): string | undefined {
  const html: string[] = [], css: string[] = [], js: string[] = [];
  for (const block of blocks) {
    if (block.type !== "code" || !block.closed) continue;
    if (block.lang === "html" || block.lang === "htm") html.push(block.code);
    else if (block.lang === "css") css.push(block.code);
    else if (block.lang === "js" || block.lang === "javascript" || block.lang === "mjs") js.push(block.code);
  }
  if (!html.length && !css.length && !js.length) return undefined;
  const escape = (code: string) => code.replace(/<\/(script|style)/gi, "<\\/$1");
  const styles = css.map((code) => `<style>\n${escape(code)}\n</style>`).join("\n");
  const scripts = js.map((code) => `<script>\n${escape(code)}\n<\/script>`).join("\n");
  let doc = html.join("\n");
  const hasHead = /<\/head>/i.test(doc), hasBody = /<\/body>/i.test(doc);
  if (!hasHead && !hasBody) return `<!doctype html><html><head><meta charset="utf-8">${styles}</head><body>${doc}${scripts}</body></html>`;
  if (styles) doc = hasHead ? doc.replace(/<\/head>/i, () => `${styles}\n</head>`) : `${doc}\n${styles}`;
  if (scripts) doc = hasBody ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${scripts}\n</body>`) : `${doc}\n${scripts}`;
  return doc;
}

/** ceil(chars / 4), the proxy's estimate. */
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

/** The proxy's output estimate: the answer plus the thinking text. */
export function outputTokensEstimate(content: string, reasoning = ""): number { return estimateTokens(content) + estimateTokens(reasoning); }

/** tokens per second, or undefined when tokens <= 0 or ms <= 0. */
export function tokensPerSecond(tokens: number, ms: number): number | undefined {
  return tokens > 0 && ms > 0 ? tokens / (ms / 1000) : undefined;
}

/** Final decode speed: outputTokens / ((totalMs - firstMs) / 1000) when firstMs is known, else outputTokens / (totalMs / 1000); undefined without outputTokens or a positive duration. */
export function decodeRate(meta: { outputTokens?: number; firstMs?: number; totalMs: number }): number | undefined {
  if (!meta.outputTokens) return undefined;
  return tokensPerSecond(meta.outputTokens, meta.firstMs !== undefined ? meta.totalMs - meta.firstMs : meta.totalMs);
}

/** "45.3 tok/s" (one decimal under 100, none above). */
export function formatRate(rate: number): string { return `${rate < 100 ? rate.toFixed(1) : Math.round(rate)} tok/s`; }

export interface ImageFormFields { /** "WxH" (a preset or the custom inputs joined). */ size: string; /** Raw steps text; blank = not sent. */ steps: string; files: number }

/** Client-side checks of the image form, only the rules that are certain (the server stays the authority): size in multiples of 32, <= 4096 per side, <= 4 megapixels; steps 2-100 when set; <= 10 reference images. undefined = fine. */
export function validateImageForm(fields: ImageFormFields): string | undefined {
  const size = /^(\d+)x(\d+)$/.exec(fields.size.trim());
  if (!size) return "Size must be WIDTHxHEIGHT, for example 1024x1024.";
  const width = Number(size[1]), height = Number(size[2]);
  if (width < 32 || height < 32 || width % 32 !== 0 || height % 32 !== 0) return "Width and height must be multiples of 32.";
  if (width > 4096 || height > 4096) return "Width and height can be at most 4096.";
  if (width * height > 4 * 1024 * 1024) return "The image can have at most 4 megapixels.";
  const steps = fields.steps.trim();
  if (steps) {
    const value = Number(steps);
    if (!Number.isInteger(value) || value < 2 || value > 100) return "Steps must be a whole number from 2 to 100 (or blank).";
  }
  if (fields.files > 10) return "At most 10 reference images.";
  return undefined;
}
