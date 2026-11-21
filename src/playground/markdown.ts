// Markdown parser and syntax highlighter of the playground (pure: no DOM, no Node APIs). Output is plain data; the page builds DOM nodes from it.
// All scans are single left-to-right passes with bounded lookahead, so a call is linear in the input size.
import { splitBlocks, type Block } from "./lib.js";

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] } // href already passed safeHref
  | { type: "br" }; // a soft line break inside a paragraph (keeps today's pre-wrap look)
export interface ListItem { children: Inline[]; sub?: ListBlock }
export interface ListBlock { type: "list"; ordered: boolean; start?: number; items: ListItem[] }
export type Align = "left" | "center" | "right" | null;
export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | ListBlock
  | { type: "blockquote"; children: MdBlock[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" }
  | { type: "code"; lang: string; code: string; closed: boolean }; // straight from splitBlocks

// ---------------------------------------------------------------------------------------------------------------------------------
// Links

/** The url when its scheme is http:, https: or mailto: (URL-parsed), else undefined. Relative urls are rejected. */
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? trimmed : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Inline

const MAX_LINK_TEXT = 2000; // lookahead bounds keep an unmatched `[` from rescanning the rest of the text
const MAX_LINK_URL = 2048;
const MAX_OPEN_DELIMS = 64; // open emphasis markers; more are literal text

const isSpace = (c: string): boolean => c === "" || /\s/.test(c);
const isPunct = (c: string): boolean => c !== "" && /[!-/:-@[-`{-~]/.test(c);
const isAsciiPunct = (c: string): boolean => c.length === 1 && /[!-/:-@[-`{-~]/.test(c);

interface Frame { char: string; count: number; children: Inline[] }

function appendText(list: Inline[], text: string): void {
  if (!text) return;
  const last = list[list.length - 1];
  if (last?.type === "text") last.text += text;
  else list.push({ type: "text", text });
}
function appendNode(list: Inline[], node: Inline): void {
  if (node.type === "text") appendText(list, node.text); else list.push(node);
}

/** Bold `**x**`/`__x__`, em `*x*`/`_x_` (no intraword `_`), `` `x` `` code (any backtick run length), `[text](url)`, `![alt](url)` → link with alt text, bare http(s) URLs autolinked, `\` escapes of ASCII punctuation, `\n` → br. Unmatched markers stay literal text. A link whose url fails safeHref becomes its text (plus nothing else). */
export function parseInline(text: string): Inline[] {
  try { return inline(text, true); } catch { return text ? [{ type: "text", text }] : []; }
}

function inline(text: string, links: boolean): Inline[] {
  const n = text.length;
  // Backtick runs: for each run start, the start of the next run of the same length (computed once, so unmatched runs cost nothing extra).
  const nextRun = new Map<number, number>();
  const runLen = new Map<number, number>();
  {
    const last = new Map<number, number>();
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < n;) {
      if (text[i] !== "`") { i++; continue; }
      let j = i;
      while (j < n && text[j] === "`") j++;
      runs.push([i, j - i]);
      i = j;
    }
    for (let k = runs.length - 1; k >= 0; k--) {
      const [start, len] = runs[k] as [number, number];
      runLen.set(start, len);
      const next = last.get(len);
      if (next !== undefined) nextRun.set(start, next);
      last.set(len, start);
    }
  }

  const root: Frame = { char: "", count: 0, children: [] };
  const stack: Frame[] = [root];
  const open: Record<string, number> = { "*": 0, "_": 0 };
  let buf = "";
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const flush = () => { if (buf) { appendText(top().children, buf); buf = ""; } };
  const push = (node: Inline) => { flush(); appendNode(top().children, node); };
  const dissolve = (frame: Frame) => { // an opener that never matched: its markers are literal text, its content moves up
    open[frame.char] = (open[frame.char] ?? 1) - 1;
    const parent = top();
    appendText(parent.children, frame.char.repeat(frame.count));
    for (const child of frame.children) appendNode(parent.children, child);
  };

  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === "\\") {
      const next = text[i + 1] ?? "";
      if (next === "\n") { buf = buf.replace(/ +$/, ""); push({ type: "br" }); i += 2; continue; }
      if (isAsciiPunct(next)) { buf += next; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === "\n") { buf = buf.replace(/ +$/, ""); push({ type: "br" }); i++; continue; }
    if (c === "`") {
      const len = runLen.get(i) ?? 1;
      const close = nextRun.get(i);
      if (close !== undefined) {
        let code = text.slice(i + len, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        push({ type: "code", text: code });
        i = close + len;
      } else { buf += "`".repeat(len); i += len; }
      continue;
    }
    if (links && (c === "[" || (c === "!" && text[i + 1] === "["))) {
      const bang = c === "!";
      const parsed = parseLink(text, bang ? i + 1 : i);
      if (parsed) {
        const href = safeHref(parsed.url);
        const children: Inline[] = bang ? [{ type: "text", text: parsed.label }] : inline(parsed.label, false);
        if (href) push({ type: "link", href, children });
        else { flush(); for (const child of children) appendNode(top().children, child); }
        i = parsed.end;
        continue;
      }
      buf += c; i++; continue;
    }
    if (links && c === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i)) && !/[A-Za-z0-9]/.test(text[i - 1] ?? "")) {
      let j = i;
      while (j < n && !/[\s<>]/.test(text[j] as string)) j++;
      let end = j;
      for (;;) { // trailing punctuation belongs to the sentence, an unbalanced `)` too
        const last = text[end - 1] ?? "";
        if (end > i && /[.,;:!?'"*_\]]/.test(last)) end--;
        else if (last === ")" && countChar(text, i, end, ")") > countChar(text, i, end, "(")) end--;
        else break;
      }
      const url = text.slice(i, end);
      const href = end - i > 8 ? safeHref(url) : undefined;
      if (href) { push({ type: "link", href, children: [{ type: "text", text: url }] }); i = end; }
      else { buf += text.slice(i, Math.max(j, i + 1)); i = Math.max(j, i + 1); }
      continue;
    }
    if (c === "*" || c === "_") {
      let j = i;
      while (j < n && text[j] === c) j++;
      let count = j - i;
      const before = text[i - 1] ?? "", after = text[j] ?? "";
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const canOpen = c === "*" ? left : left && (!right || isPunct(before));
      const canClose = c === "*" ? right : right && (!left || isPunct(after));
      flush();
      if (canClose && (open[c] ?? 0) > 0) {
        while (count > 0 && (open[c] ?? 0) > 0) {
          while (top().char !== c) dissolve(stack.pop() as Frame); // markers of the other kind in between never matched
          const frame = top();
          const use = count >= 2 && frame.count >= 2 ? 2 : 1;
          frame.children = [{ type: use === 2 ? "strong" : "em", children: frame.children }];
          frame.count -= use;
          count -= use;
          if (frame.count === 0) {
            stack.pop();
            open[c] = (open[c] ?? 1) - 1;
            for (const child of frame.children) appendNode(top().children, child);
          }
        }
      }
      if (count > 0) {
        if (canOpen && stack.length <= MAX_OPEN_DELIMS) { stack.push({ char: c, count, children: [] }); open[c] = (open[c] ?? 0) + 1; }
        else appendText(top().children, c.repeat(count));
      }
      i = j;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  while (stack.length > 1) dissolve(stack.pop() as Frame);
  return root.children;
}

function countChar(text: string, from: number, to: number, char: string): number {
  let count = 0;
  for (let i = from; i < to; i++) if (text[i] === char) count++;
  return count;
}

/** `[label](url "title")` starting at the `[` at `start`; bounded lookahead. */
function parseLink(text: string, start: number): { label: string; url: string; end: number } | undefined {
  const n = text.length;
  let depth = 0, i = start;
  const stop = Math.min(n, start + MAX_LINK_TEXT);
  for (; i < stop; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (i >= stop || text[i] !== "]" || text[i + 1] !== "(") return undefined;
  const label = text.slice(start + 1, i);
  let j = i + 2;
  while (text[j] === " " || text[j] === "\n") j++;
  const urlStart = j;
  let parens = 0;
  const urlStop = Math.min(n, j + MAX_LINK_URL);
  if (text[j] === "<") {
    const close = text.indexOf(">", j);
    if (close < 0 || close >= urlStop) return undefined;
    const url = text.slice(j + 1, close);
    j = close + 1;
    return finishLink(text, label, url, j);
  }
  for (; j < urlStop; j++) {
    const c = text[j] as string;
    if (c === "\\") j++;
    else if (c === "(") parens++;
    else if (c === ")") { if (parens === 0) break; parens--; }
    else if (c === " " || c === "\n" || c === "\t") break;
  }
  if (j >= urlStop && j < n) return undefined;
  return finishLink(text, label, text.slice(urlStart, j).replace(/\\(?=[!-/:-@[-`{-~])/g, ""), j);
}

function finishLink(text: string, label: string, url: string, from: number): { label: string; url: string; end: number } | undefined {
  let j = from;
  while (text[j] === " " || text[j] === "\n") j++;
  const q = text[j];
  if (q === '"' || q === "'") { // optional title
    const stop = Math.min(text.length, j + MAX_LINK_URL);
    let k = j + 1;
    for (; k < stop; k++) { if (text[k] === "\\") k++; else if (text[k] === q) break; }
    if (k >= stop || text[k] !== q) return undefined;
    j = k + 1;
    while (text[j] === " " || text[j] === "\n") j++;
  }
  return text[j] === ")" ? { label, url, end: j + 1 } : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Blocks

const MAX_NESTING = 6; // blockquote / list depth; deeper text stays literal

function indentOf(line: string): number {
  let width = 0;
  for (const c of line) {
    if (c === " ") width++;
    else if (c === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function isHr(line: string): boolean {
  if (indentOf(line) > 3) return false;
  const t = line.trim();
  const c = t[0];
  if (c !== "-" && c !== "*" && c !== "_") return false;
  let count = 0;
  for (const ch of t) {
    if (ch === c) count++;
    else if (ch !== " " && ch !== "\t") return false;
  }
  return count >= 3;
}

function headingOf(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | undefined {
  if (indentOf(line) > 3) return undefined;
  const t = line.trimStart();
  let level = 0;
  while (t[level] === "#") level++;
  if (level < 1 || level > 6) return undefined;
  const rest = t.slice(level);
  if (rest && rest[0] !== " " && rest[0] !== "\t") return undefined;
  let body = rest.trim();
  let end = body.length;
  while (end > 0 && body[end - 1] === "#") end--; // optional closing #s, only when preceded by a space (or the whole body)
  if (end < body.length && (end === 0 || body[end - 1] === " " || body[end - 1] === "\t")) body = body.slice(0, end).trim();
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text: body };
}

interface Marker { indent: number; ordered: boolean; number: number; text: string }
/** A list marker line: `-`, `*`, `+`, `1.` or `1)` followed by a space or the end of the line. */
function markerOf(line: string): Marker | undefined {
  const indent = indentOf(line);
  const t = line.trimStart();
  const first = t[0] ?? "";
  let len = 0, ordered = false, number = 0;
  if (first === "-" || first === "*" || first === "+") len = 1;
  else if (first >= "0" && first <= "9") {
    while (len < 10 && (t[len] ?? "") >= "0" && (t[len] ?? "") <= "9") len++;
    if (len > 9 || (t[len] !== "." && t[len] !== ")")) return undefined;
    ordered = true; number = Number(t.slice(0, len)); len++;
  } else return undefined;
  const after = t[len];
  if (after !== undefined && after !== " " && after !== "\t") return undefined;
  return { indent, ordered, number, text: t.slice(len).trim() };
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (c === "\\" && t[i + 1] === "|") { cell += "\\|"; i++; }
    else if (c === "|") { cells.push(cell.trim()); cell = ""; }
    else cell += c;
  }
  if (cell.trim() || !line.trim().endsWith("|")) cells.push(cell.trim());
  return cells;
}

function delimiterAligns(line: string, columns: number): Align[] | undefined {
  if (!line.includes("|") || !line.includes("-")) return undefined;
  const cells = splitRow(line);
  if (cells.length !== columns) return undefined;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return undefined;
    aligns.push(cell.startsWith(":") ? (cell.endsWith(":") ? "center" : "left") : cell.endsWith(":") ? "right" : null);
  }
  return aligns;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i], delim = lines[i + 1];
  return head !== undefined && delim !== undefined && head.includes("|") && delimiterAligns(delim, splitRow(head).length) !== undefined;
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) { i++; continue; }
    if (isHr(line)) { blocks.push({ type: "hr" }); i++; continue; }
    const heading = headingOf(line);
    if (heading) { blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.text) }); i++; continue; }
    if (indentOf(line) <= 3 && line.trimStart().startsWith(">") && depth < MAX_NESTING) {
      const inner: string[] = [];
      while (i < lines.length && indentOf(lines[i] as string) <= 3 && (lines[i] as string).trimStart().startsWith(">")) {
        inner.push((lines[i] as string).trimStart().slice(1).replace(/^ /, ""));
        i++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner, depth + 1) });
      continue;
    }
    const marker = markerOf(line);
    if (marker && marker.indent <= 3) {
      const parsed = parseList(lines, i, depth);
      blocks.push(parsed.list);
      i = parsed.next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align = delimiterAligns(lines[i + 1] as string, head.length) as Align[];
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|")) {
        const cells = splitRow(lines[i] as string);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      blocks.push({ type: "table", align, head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i] as string;
      if (!next.trim() || isHr(next) || headingOf(next) || (indentOf(next) <= 3 && next.trimStart().startsWith(">") && depth < MAX_NESTING) || isTableStart(lines, i)) break;
      const m = markerOf(next);
      if (m && m.indent <= 3 && (!m.ordered || m.number === 1)) break;
      para.push(next.trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** The list whose first marker line is `lines[start]`; items follow at the same level, a more indented marker (>= 2 columns deeper) opens the item's sub list. */
function parseList(lines: string[], start: number, depth: number): { list: ListBlock; next: number } {
  const first = markerOf(lines[start] as string) as Marker;
  const list: ListBlock = { type: "list", ordered: first.ordered, items: [] };
  if (first.ordered && first.number !== 1) list.start = first.number;
  const base = first.indent;
  let i = start;
  while (i < lines.length) {
    const marker = markerOf(lines[i] as string);
    if (!marker || marker.indent >= base + 2 || marker.ordered !== first.ordered || isHr(lines[i] as string)) break;
    const textLines = [marker.text];
    const body: string[] = [];
    i++;
    let previousBlank = false;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (!line.trim()) { // a blank line continues the list only when an item line or more indented text follows
        let j = i;
        while (j < lines.length && !(lines[j] as string).trim()) j++;
        const after = lines[j];
        if (after === undefined) { i = j; break; }
        const afterMarker = markerOf(after);
        if (indentOf(after) >= base + 2 || (afterMarker && afterMarker.indent < base + 2 && afterMarker.ordered === first.ordered && !isHr(after))) { i = j; previousBlank = true; continue; }
        break;
      }
      const m = markerOf(line);
      if (indentOf(line) < base + 2) {
        if (m && !isHr(line)) break; // next item (or a list of the other kind: ends this one)
        if (previousBlank || isHr(line) || headingOf(line) || line.trimStart().startsWith(">") || isTableStart(lines, i)) break;
      }
      body.push(line);
      previousBlank = false;
      i++;
    }
    const item: ListItem = { children: [] };
    let sub = -1;
    if (depth < MAX_NESTING) sub = body.findIndex((line) => { const m = markerOf(line); return m !== undefined && !isHr(line) && m.indent >= base + 2; });
    for (const line of sub < 0 ? body : body.slice(0, sub)) textLines.push(line.trim());
    item.children = parseInline(textLines.join("\n"));
    if (sub >= 0) item.sub = parseList(body.slice(sub), 0, depth + 1).list;
    list.items.push(item);
  }
  return { list, next: Math.max(i, start + 1) };
}

/** splitBlocks(source) first; each text block goes through the block parser, each code block becomes a "code" MdBlock unchanged. Never throws; any input gives some blocks. */
export function parseMarkdown(source: string): MdBlock[] {
  try {
    const out: MdBlock[] = [];
    for (const block of splitBlocks(source) as Block[]) {
      if (block.type === "code") out.push({ type: "code", lang: block.lang, code: block.code, closed: block.closed });
      else out.push(...parseBlocks(block.text.split("\n"), 0));
    }
    return out;
  } catch {
    return source ? [{ type: "paragraph", children: [{ type: "text", text: source }] }] : [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Highlighter

export type TokenClass = "kw" | "str" | "com" | "num" | "tag" | "attr" | "lit";
export interface Token { text: string; cls?: TokenClass }

const MAX_HIGHLIGHT = 100_000;
const words = (list: string): Set<string> => new Set(list.split(" "));

const JS_KW = words("break case catch class const continue debugger default delete do else enum export extends finally for function if implements import in instanceof interface let new of package private protected public return static super switch this throw try typeof var void while with yield async await as from get set type namespace declare readonly abstract keyof satisfies");
const PY_KW = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self");
const SH_KW = words("if then else elif fi for while until do done case esac function in return export local readonly unset select time source alias exit break continue set shift trap cd echo");
const LITERALS = words("true false null undefined NaN Infinity True False None nil");

interface LexConfig {
  line?: string[]; // line comment openers
  block?: Array<[string, string]>;
  quotes?: string; // string delimiters
  triple?: boolean; // """ and ''' strings (python)
  multilineQuote?: string; // quotes whose strings may span lines
  keywords?: Set<string>;
  literals?: boolean;
  keyAttr?: boolean; // a string followed by `:` is an attr (json keys)
  hashAtWordStart?: boolean; // `#` starts a comment only at the start of a word (bash)
  dollar?: boolean; // $var / ${var}
  css?: boolean;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c > "\u007f";
const isIdPart = (c: string): boolean => isIdStart(c) || isDigit(c);

class Out {
  tokens: Token[] = [];
  add(text: string, cls?: TokenClass): void {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.cls === cls) last.text += text;
    else this.tokens.push(cls ? { text, cls } : { text });
  }
}

function stringEnd(code: string, start: number, quote: string, multiline: boolean): number {
  const n = code.length;
  let j = start + 1;
  while (j < n) {
    const c = code[j] as string;
    if (c === "\\") j += 2;
    else if (c === quote) return j + 1;
    else if (c === "\n" && !multiline) return j; // unterminated: stops at the line end
    else j++;
  }
  return n;
}

function lex(code: string, cfg: LexConfig): Token[] {
  const out = new Out();
  const n = code.length;
  const kw = cfg.keywords ?? new Set<string>();
  let depth = 0; // css braces
  let i = 0;
  while (i < n) {
    const c = code[i] as string;
    let done = false;
    for (const open of cfg.line ?? []) {
      if (!code.startsWith(open, i) || (cfg.hashAtWordStart && i > 0 && !/\s/.test(code[i - 1] as string))) continue;
      const nl = code.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      out.add(code.slice(i, end), "com"); i = end; done = true; break;
    }
    if (done) continue;
    for (const [open, close] of cfg.block ?? []) {
      if (!code.startsWith(open, i)) continue;
      const at = code.indexOf(close, i + open.length);
      const end = at < 0 ? n : at + close.length;
      out.add(code.slice(i, end), "com"); i = end; done = true; break;
    }
    if (done) continue;
    if (cfg.quotes?.includes(c)) {
      let end: number;
      if (cfg.triple && code.startsWith(c.repeat(3), i)) { const at = code.indexOf(c.repeat(3), i + 3); end = at < 0 ? n : at + 3; }
      else end = stringEnd(code, i, c, cfg.multilineQuote?.includes(c) ?? false);
      let cls: TokenClass = "str";
      if (cfg.keyAttr) { let k = end; while (code[k] === " " || code[k] === "\t") k++; if (code[k] === ":") cls = "attr"; }
      out.add(code.slice(i, end), cls); i = end; continue;
    }
    if (cfg.css) {
      if (c === "{") depth++; else if (c === "}" && depth > 0) depth--;
      if (c === "#" && /[0-9a-fA-F]/.test(code[i + 1] ?? "")) { let j = i + 1; while (j < n && /[0-9a-zA-Z]/.test(code[j] as string)) j++; out.add(code.slice(i, j), "num"); i = j; continue; }
      if (c === "@" && isIdStart(code[i + 1] ?? "")) { let j = i + 1; while (j < n && (isIdPart(code[j] as string) || code[j] === "-")) j++; out.add(code.slice(i, j), "kw"); i = j; continue; }
    }
    if (cfg.dollar && c === "$" && (isIdStart(code[i + 1] ?? "") || code[i + 1] === "{")) {
      let j = i + 1;
      if (code[j] === "{") { const at = code.indexOf("}", j); j = at < 0 ? n : at + 1; }
      else while (j < n && isIdPart(code[j] as string)) j++;
      out.add(code.slice(i, j), "attr"); i = j; continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isIdPart(code[j] as string) || code[j] === "." || (cfg.css && code[j] === "%"))) j++;
      out.add(code.slice(i, j), "num"); i = j; continue;
    }
    if (isIdStart(c) || (cfg.css && c === "-" && (isIdStart(code[i + 1] ?? "") || code[i + 1] === "-"))) {
      let j = i + 1;
      while (j < n && (isIdPart(code[j] as string) || (cfg.css && code[j] === "-"))) j++;
      const word = code.slice(i, j);
      let cls: TokenClass | undefined;
      if (cfg.css) {
        let k = j; while (code[k] === " " || code[k] === "\t") k++;
        if (depth > 0 && code[k] === ":" && code[k + 1] !== ":") cls = "attr";
      } else if (kw.has(word)) cls = "kw";
      else if (cfg.literals && LITERALS.has(word)) cls = "lit";
      out.add(word, cls); i = j; continue;
    }
    out.add(c); i++;
  }
  return out.tokens;
}

function lexMarkup(code: string): Token[] {
  const out = new Out();
  const n = code.length;
  let i = 0;
  while (i < n) {
    if (code.startsWith("<!--", i)) {
      const at = code.indexOf("-->", i + 4);
      const end = at < 0 ? n : at + 3;
      out.add(code.slice(i, end), "com"); i = end; continue;
    }
    const next = code[i + 1] ?? "";
    if (code[i] === "<" && (/[A-Za-z!?]/.test(next) || (next === "/" && /[A-Za-z]/.test(code[i + 2] ?? "")))) {
      let j = i + 1;
      if (code[j] === "/" || code[j] === "!" || code[j] === "?") j++;
      while (j < n && /[^\s/>]/.test(code[j] as string)) j++;
      out.add(code.slice(i, j), "tag");
      i = j;
      while (i < n && code[i] !== ">") { // attributes
        const c = code[i] as string;
        if (c === '"' || c === "'") { const end = stringEnd(code, i, c, true); out.add(code.slice(i, end), "str"); i = end; }
        else if (/[^\s=/>"']/.test(c)) { let k = i; while (k < n && /[^\s=/>"']/.test(code[k] as string)) k++; out.add(code.slice(i, k), "attr"); i = k; }
        else if (c === "/" && code[i + 1] === ">") break;
        else { out.add(c); i++; }
      }
      if (i < n) { const end = code[i] === "/" ? i + 2 : i + 1; out.add(code.slice(i, end), "tag"); i = end; }
      continue;
    }
    out.add(code[i] as string); i++;
  }
  return out.tokens;
}

const SLASH_COMMENTS: LexConfig = { line: ["//"], block: [["/*", "*/"]] };

/** Lossless: tokens.map(t => t.text).join("") === code. Languages: js|javascript|mjs|cjs|jsx|ts|typescript|tsx, html|htm|xml|svg, css|scss, json, python|py, bash|sh|shell|zsh|console; anything else (incl. "") the generic rule (strings, numbers, and slash-slash, hash and slash-star comments). Code over 100_000 chars returns one plain token. */
export function highlight(code: string, lang: string): Token[] {
  if (!code) return [];
  if (code.length > MAX_HIGHLIGHT) return [{ text: code }];
  try {
    switch (lang.trim().toLowerCase()) {
      case "js": case "javascript": case "mjs": case "cjs": case "jsx": case "ts": case "typescript": case "tsx":
        return lex(code, { ...SLASH_COMMENTS, quotes: "\"'`", multilineQuote: "`", keywords: JS_KW, literals: true });
      case "html": case "htm": case "xml": case "svg":
        return lexMarkup(code);
      case "css":
        return lex(code, { block: [["/*", "*/"]], quotes: "\"'", css: true });
      case "scss":
        return lex(code, { ...SLASH_COMMENTS, quotes: "\"'", css: true });
      case "json":
        return lex(code, { quotes: '"', keyAttr: true, literals: true });
      case "python": case "py":
        return lex(code, { line: ["#"], quotes: "\"'", triple: true, keywords: PY_KW, literals: true });
      case "bash": case "sh": case "shell": case "zsh": case "console":
        return lex(code, { line: ["#"], hashAtWordStart: true, quotes: "\"'", multilineQuote: "\"'", keywords: SH_KW, literals: false, dollar: true });
      default:
        return lex(code, { line: ["//", "#"], block: [["/*", "*/"]], quotes: "\"'" });
    }
  } catch { return [{ text: code }]; }
}
