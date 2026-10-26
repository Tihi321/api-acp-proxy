/** A `url_citation`: `start_index` / `end_index` are UTF-16 offsets into the answer text, so `text.slice(start_index, end_index)` is the cited text (a whole `[title](url)` link, or a bare URL). */
export interface UrlCitation { start_index: number; end_index: number; url: string; title: string }

// [title](url) or [title](<url>), with an optional "title" after the URL; one level of balanced parentheses in the URL. A leading `!` (an image) is checked by the caller.
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((<[^>\s]+>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g;
const BARE_URL = /https?:\/\/[^\s<>"'`\]\[]+/g;

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function isHttp(url: string): boolean { try { const { protocol } = new URL(url); return protocol === "http:" || protocol === "https:"; } catch { return false; } }

/** A bare URL without the punctuation that ends a sentence (and a closing parenthesis that has no opening one inside the URL). */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,;:!?*_~'\"".includes(last)) end--;
    else if (last === ")" && url.slice(0, end).split("(").length < url.slice(0, end).split(")").length) end--;
    else break;
  }
  return url.slice(0, end);
}

/**
 * The citations of an answer: its Markdown links `[title](url)` and its bare `http(s)` URLs, in text order. Only what the text holds: nothing is added for a source the agent did not write down.
 * A link's title is its text (the host name when empty); a bare URL's title is its host name. Images (`![alt](url)`) and links to other schemes are left out.
 */
export function extractCitations(text: string): UrlCitation[] {
  const found: UrlCitation[] = [];
  const covered: Array<[number, number]> = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const start = match.index;
    covered.push([start, start + match[0].length]);
    const raw = match[2]!;
    const url = raw.startsWith("<") ? raw.slice(1, -1) : raw;
    if (text[start - 1] === "!" || !isHttp(url)) continue;
    found.push({ start_index: start, end_index: start + match[0].length, url, title: match[1]!.trim() || hostOf(url) });
  }
  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index;
    if (covered.some(([from, to]) => start >= from && start < to)) continue;
    const url = trimUrl(match[0]);
    if (!isHttp(url) || url.length <= "https://".length) continue;
    found.push({ start_index: start, end_index: start + url.length, url, title: hostOf(url) });
  }
  return found.sort((a, b) => a.start_index - b.start_index);
}
