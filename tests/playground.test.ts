import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ActivityLog } from "../src/activity.js";
import type { AcpLike } from "../src/acp.js";
import type { ProxyConfig } from "../src/config.js";
import { PLAYGROUND_CSP, PREVIEW_CSP, servePlayground } from "../src/playground-files.js";
import { chatTitle, curlFor, decodeRate, elideDataUrls, estimateTokens, formatMs, groupModels, isHttpUrl, outputTokensEstimate, parseSseLines, parseUiPrefs, previewDocument, sendKey, splitBlocks, timingSegments, tokensPerSecond, userContent, validateImageForm } from "../src/playground/lib.js";
import { dateGroup, historySections, moveChat, normalizeChats, setPinned, touchChat, trimChats, type ChatLike } from "../src/playground/history.js";
import { highlight, parseMarkdown, safeHref } from "../src/playground/markdown.js";
import { createProxyServer } from "../src/server.js";
import { tempRoot } from "./helpers/temp-root.js";

describe("playground helpers", () => {
  it("groups models by provider and shows an unprefixed twin once, prefixed", () => {
    const ids = ["gpt-6-luna", "codex/gpt-6-luna", "gpt-5.6-terra", "codex/gpt-5.6-terra", "antigravity/gemini-4-argon", "solo"];
    expect(groupModels(ids)).toEqual([
      { provider: "codex", models: ["codex/gpt-6-luna", "codex/gpt-5.6-terra"] },
      { provider: "antigravity", models: ["antigravity/gemini-4-argon"] },
      { provider: "other", models: ["solo"] },
    ]);
    expect(groupModels([])).toEqual([]);
  });

  it("parses SSE data lines across chunk boundaries", () => {
    const first = parseSseLines('data: {"a":1}\n\ndata: {"b"');
    expect(first).toEqual({ events: ['{"a":1}'], rest: 'data: {"b"' });
    const second = parseSseLines(`${first.rest}:2}\r\n\r\ndata: [DONE]\n\n`);
    expect(second).toEqual({ events: ['{"b":2}', "[DONE]"], rest: "" });
    expect(parseSseLines(": comment\nevent: x\n").events).toEqual([]);
  });

  it("builds a curl command without the key and with shell-safe quoting", () => {
    const body = { model: "codex/gpt-6-luna", messages: [{ role: "user", content: "it's" }] };
    const withKey = curlFor("http://127.0.0.1:8787/v1", body, true);
    expect(withKey).toContain("'http://127.0.0.1:8787/v1/chat/completions'");
    expect(withKey).toContain('Authorization: Bearer $ACP_PROXY_KEY');
    expect(withKey).toContain(`it'\\''s`);
    expect(curlFor("http://127.0.0.1:8787/v1", body, false)).not.toContain("Authorization");
  });

  it("titles, times and links", () => {
    expect(chatTitle("  hello\n  world ")).toBe("hello world");
    expect(chatTitle("")).toBe("New chat");
    expect(chatTitle("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`);
    expect(formatMs(850)).toBe("850 ms");
    expect(formatMs(3240)).toBe("3.2 s");
    expect(formatMs(65_000)).toBe("1 min 5 s");
    expect(isHttpUrl("https://example.com/a")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });

  it("splits fenced blocks and combines html, css and js into one preview document", () => {
    const blocks = splitBlocks("Intro\n```html\n<button id=b>Go</button>\n```\nMiddle\n~~~css\nbutton { color: red }\n~~~\n```js title\nconsole.log('</script>')");
    expect(blocks).toEqual([
      { type: "text", text: "Intro" },
      { type: "code", lang: "html", code: "<button id=b>Go</button>", closed: true },
      { type: "text", text: "Middle" },
      { type: "code", lang: "css", code: "button { color: red }", closed: true },
      { type: "code", lang: "js", code: "console.log('</script>')", closed: false },
    ]);
    const closed = splitBlocks("```html\n<p>hi</p>\n```\n```css\np { color: red }\n```\n```js\nalert('</script>')\n```");
    const doc = previewDocument(closed) ?? "";
    expect(doc).toContain("<p>hi</p>");
    expect(doc).toContain("<style>");
    expect(doc).toContain("<script>");
    expect(doc).toContain("<\\/script>')");
    expect(previewDocument(splitBlocks("```python\nprint(1)\n```"))).toBeUndefined();
  });

  it("computes live and decode tokens per second", () => {
    expect(decodeRate({ outputTokens: 100, firstMs: 1000, totalMs: 3000 })).toBe(50);
    expect(decodeRate({ outputTokens: 100, totalMs: 2000 })).toBe(50);
    expect(decodeRate({ totalMs: 2000 })).toBeUndefined();
    expect(tokensPerSecond(estimateTokens("x".repeat(400)), 2000)).toBe(50);
    expect(outputTokensEstimate("x".repeat(200), "y".repeat(200))).toBe(100);
    expect(outputTokensEstimate("x".repeat(400))).toBe(100);
  });

  it("parses markdown into an AST: inline marks, safe links, raw html as text, tables, nested lists, quotes, hr and an unclosed fence", () => {
    const source = [
      "# Title", "",
      "Some **b**, *i*, `c`, [ok](https://a.example) and [bad](javascript:alert(1)).", "",
      "<script>alert(1)</script>", "",
      "| Name | Qty | Sum |", "|:--|:-:|--:|", "| a | 1 | 2 |", "",
      "- one", "  1. inner", "- two", "",
      "> quoted", "", "---", "", "```js", "let x = 1",
    ].join("\n");
    const t = (text: string) => ({ type: "text", text });
    expect(parseMarkdown(source)).toEqual([
      { type: "heading", level: 1, children: [t("Title")] },
      { type: "paragraph", children: [
        t("Some "), { type: "strong", children: [t("b")] }, t(", "), { type: "em", children: [t("i")] }, t(", "), { type: "code", text: "c" }, t(", "),
        { type: "link", href: "https://a.example", children: [t("ok")] }, t(" and bad."),
      ] },
      { type: "paragraph", children: [t("<script>alert(1)</script>")] },
      { type: "table", align: ["left", "center", "right"], head: [[t("Name")], [t("Qty")], [t("Sum")]], rows: [[[t("a")], [t("1")], [t("2")]]] },
      { type: "list", ordered: false, items: [{ children: [t("one")], sub: { type: "list", ordered: true, items: [{ children: [t("inner")] }] } }, { children: [t("two")] }] },
      { type: "blockquote", children: [{ type: "paragraph", children: [t("quoted")] }] },
      { type: "hr" },
      { type: "code", lang: "js", code: "let x = 1", closed: false },
    ]);
    expect(safeHref("mailto:a@b.c")).toBeDefined();
    expect(safeHref("/x")).toBeUndefined();
    // no answer text is ever dropped, also after a nested list of the other kind
    const texts = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(texts) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => k === "text" && typeof v === "string" ? [v] : texts(v)) : [];
    for (const [md, words] of [["- x\n  1. a\n  - b\n- y", ["x", "a", "b", "y"]], ["1. w0\n    - w1\n    1. w2", ["w0", "w1", "w2"]], ["- x\n  - a\n\n  1. b", ["x", "a", "b"]]] as const) {
      const all = texts(parseMarkdown(md)).join(" ");
      for (const word of words) expect(all).toContain(word);
    }
    // linear time on long space and paren runs
    for (const hostile of ["a" + " ".repeat(100000) + "b" + "\nc", "http://ab.example/" + ")".repeat(50000)]) {
      const started = Date.now();
      parseMarkdown(hostile);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("validates the image form: size rules, steps range, file count", () => {
    expect(validateImageForm({ size: "1024x1024", steps: "", files: 0 })).toBeUndefined();
    expect(validateImageForm({ size: "1000x1000", steps: "", files: 0 })).toBeDefined();
    expect(validateImageForm({ size: "4128x64", steps: "", files: 0 })).toBeDefined();
    expect(validateImageForm({ size: "1024x1024", steps: "1", files: 0 })).toBeDefined();
    expect(validateImageForm({ size: "1024x1024", steps: "", files: 11 })).toBeDefined();
  });

  it("history: migrates old chats, sections pinned and date groups, moves, pins, trims", () => {
    const now = new Date(2026, 5, 15, 12).getTime();
    const day = (back: number, hour = 12) => new Date(2026, 5, 15 - back, hour).getTime();
    const chat = (id: string, updated: number, extra: Partial<ChatLike> = {}): ChatLike => ({ id, title: id, updated, messages: [{ role: "user", content: `about ${id}` }], ...extra });
    // an old array (most recent first, no pinned/order) keeps its visible order; bad entries are dropped
    const old = normalizeChats<ChatLike>([chat("a", day(0)), { id: "bad", title: "x", updated: 1 }, chat("b", day(0, 9)), chat("c", day(1)), chat("d", day(8))]);
    expect(old.map((c) => [c.id, c.pinned])).toEqual([["a", false], ["b", false], ["c", false], ["d", false]]);
    expect(historySections(old, now).map((s) => [s.label, s.ids])).toEqual([["Today", ["a", "b"]], ["Yesterday", ["c"]], ["Older", ["d"]]]);
    // date groups switch at local midnight: yesterday, day 7 and day 8
    expect([dateGroup(now, now), dateGroup(day(1, 23), now), dateGroup(day(1, 0), now), dateGroup(day(2, 23), now), dateGroup(day(7, 0), now), dateGroup(day(8, 23), now)]).toEqual(["today", "yesterday", "yesterday", "week", "week", "older"]);
    expect(historySections(old, now, "  ABOUT C ").map((s) => s.ids)).toEqual([["c"]]);
    // pins: top of Pinned, a pinned chat keeps its place on activity, an unpinned one jumps to the top of Today
    let chats = setPinned(setPinned(old, "c", true, now), "d", true, now);
    expect(historySections(chats, now)[0]).toMatchObject({ key: "pinned", ids: ["d", "c"] });
    const touched = touchChat(chats, "c", now + 1000);
    expect(touched.find((c) => c.id === "c")).toMatchObject({ updated: now + 1000, order: chats.find((c) => c.id === "c")?.order });
    expect(historySections(touchChat(chats, "b", now + 1000), now)[1]!.ids).toEqual(["b", "a"]);
    // moves: within Pinned, a forbidden cross-bucket move leaves the input unchanged, a drop into Pinned pins
    chats = moveChat(chats, "c", { section: "pinned", index: 0 }, now);
    expect(historySections(chats, now)[0]!.ids).toEqual(["c", "d"]);
    expect(moveChat(chats, "a", { section: "yesterday", index: 0 }, now)).toEqual(chats);
    const pinned = moveChat(chats, "b", { section: "pinned", index: 1 }, now);
    expect(historySections(pinned, now)[0]!.ids).toEqual(["c", "b", "d"]);
    expect(pinned.find((c) => c.id === "b")?.pinned).toBe(true);
    expect(historySections(moveChat(pinned, "c", { section: "today", index: 0 }, now), now).map((s) => s.ids)).toEqual([["b", "d"], ["a"], ["c"]]); // c lands in the bucket of its own date
    expect(old.every((c) => c.pinned === false)).toBe(true); // input never mutated
    // the cap keeps every pinned chat
    const many = [...Array.from({ length: 5 }, (_, i) => chat(`n${i}`, now - i * 1000)), chat("old-pin", 1, { pinned: true })];
    expect(trimChats(many, 3).map((c) => c.id)).toEqual(["n0", "n1", "old-pin"]);
    expect(trimChats(many.map((c) => ({ ...c, pinned: true })), 3)).toHaveLength(6);
  });

  it("composer and request helpers: send key, content parts, elided data URLs, prefs, timing", () => {
    const key = (over: Partial<Parameters<typeof sendKey>[0]>) => sendKey({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...over });
    expect([key({}), key({ shiftKey: true }), key({ ctrlKey: true }), key({ metaKey: true }), key({ isComposing: true }), key({ key: "a" })]).toEqual([true, false, true, true, false, false]);
    expect(userContent("hi", [])).toBe("hi");
    expect(userContent("hi", ["data:image/png;base64,AAAA"])).toEqual([{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
    const request = { model: "m", messages: [{ role: "user", content: userContent("see", ["data:image/png;base64," + "A".repeat(2048)]) }] };
    const elided = JSON.stringify(elideDataUrls(request));
    expect(elided).toContain("data:…(3 KB)");
    expect(elided).not.toContain("AAAA");
    expect(elided).toContain('"model":"m"');
    expect(request.messages[0]!.content[1]).toMatchObject({ type: "image_url" }); // input untouched
    const defaults = parseUiPrefs(null);
    expect(defaults).toMatchObject({ sidebarOpen: true, sidebarWidth: 264, previewWidth: 0, stream: true, image: { size: "1024x1024", steps: "" } });
    expect(parseUiPrefs("{not json")).toEqual(defaults);
    expect(parseUiPrefs('{"sidebarWidth":9999,"previewWidth":-5,"stream":"yes","sidebarOpen":false,"image":{"steps":"20","seed":7}}')).toMatchObject({ sidebarWidth: 420, previewWidth: 0, stream: true, sidebarOpen: false, image: { steps: "20", seed: "" } });
    expect(parseUiPrefs('{"sidebarWidth":5}').sidebarWidth).toBe(200);
    for (const [meta, thought] of [[{ firstMs: 1000, totalMs: 8000 }, 3000], [{ firstMs: 1000, totalMs: 8000 }, undefined], [{ totalMs: 0 }, undefined]] as const) {
      const s = timingSegments(meta, thought);
      expect(s.wait + s.think + s.write).toBeCloseTo(1, 10);
    }
    expect(timingSegments({ firstMs: 4000, totalMs: 8000 }, 3000)).toEqual({ wait: 0.5, think: 0.375, write: 0.125 });
    expect(timingSegments({ firstMs: 1000, totalMs: 4000 })).toEqual({ wait: 0.25, think: 0, write: 0.75 });
  });

  it("highlights losslessly and classifies js tokens and html tags", () => {
    const js = 'const s = "x"; // c\nlet n = 42;';
    const tokens = highlight(js, "js");
    expect(tokens.map((token) => token.text).join("")).toBe(js);
    expect(tokens).toEqual(expect.arrayContaining([{ text: "const", cls: "kw" }, { text: '"x"', cls: "str" }, { text: "// c", cls: "com" }, { text: "42", cls: "num" }]));
    const html = highlight('<a href="x">', "html");
    expect(html.map((token) => token.cls)).toEqual(expect.arrayContaining(["tag", "attr"]));
    const odd = "weird 'unclosed\n\\ /* never";
    expect(highlight(odd, "nope").map((token) => token.text).join("")).toBe(odd);
  });
});

const root = tempRoot("playground");
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  servers = [];
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function get(port: number, pathname: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, method }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk))); res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
}

describe("serving the playground", () => {
  it("serves the page and its fixed files with a strict CSP, and nothing else", async () => {
    const dir = path.join(root, "built");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [["playground.html", "<!doctype html>page"], ["playground.js", "js"], ["lib.js", "lib"], ["markdown.js", "md"], ["history.js", "hist"], ["dom.js", "dom"], ["messages.js", "msg"], ["sidebar.js", "side"], ["composer.js", "comp"], ["playground.css", "css"], ["preview.html", "<!doctype html>preview"], ["secret.txt", "no"]] as Array<[string, string]>) writeFileSync(path.join(dir, name), body);
    const port = await listen(createServer((req, res) => { void servePlayground(req.method ?? "GET", new URL(req.url ?? "/", "http://x").pathname, res, dir).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } }); }));
    const page = await get(port, "/playground");
    expect(page).toMatchObject({ status: 200, text: "<!doctype html>page" });
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(PLAYGROUND_CSP);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(await get(port, "/playground/playground.js")).toMatchObject({ status: 200, text: "js" });
    expect(await get(port, "/playground/markdown.js")).toMatchObject({ status: 200, text: "md" });
    expect(await get(port, "/playground/history.js")).toMatchObject({ status: 200, text: "hist" });
    expect((await get(port, "/playground/markdown.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await get(port, "/playground/playground.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
    const preview = await get(port, "/playground/preview");
    expect(preview).toMatchObject({ status: 200, text: "<!doctype html>preview" });
    expect(preview.headers["content-security-policy"]).toBe(PREVIEW_CSP);
    expect(PLAYGROUND_CSP).toContain("frame-src 'self'");
    expect(PLAYGROUND_CSP).toContain("frame-ancestors 'none'");
    expect(PREVIEW_CSP.startsWith("sandbox allow-scripts")).toBe(true);
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect((await get(port, "/playground/secret.txt")).status).toBe(404);
    expect((await get(port, "/playground/../package.json")).status).not.toBe(200);
    expect((await get(port, "/playground", "POST")).status).toBe(405);
    expect((await get(port, "/v1/models")).status).toBe(418); // not ours
  });

  it("answers before the API key check and is not logged as activity", async () => {
    const config: ProxyConfig = { host: "127.0.0.1", port: 0, maxBodyBytes: 100_000, timeoutMs: 5000, workRoot: path.join(root, "work"), acpArgs: [], apiKey: "secret" };
    const bridge: AcpLike = { generate: async () => ({ text: "", stopReason: "end_turn", usage: null }), hasModel: () => true, listModels: async () => [] };
    const activity = new ActivityLog();
    const port = await listen(createProxyServer(config, bridge, { activity }));
    const missing = await get(port, "/playground/unknown.js");
    expect(missing.status).toBe(404);
    expect(missing.headers["content-security-policy"]).toBe(PLAYGROUND_CSP);
    expect((await get(port, "/v1/models")).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activity.list().map((entry) => entry.endpoint)).toEqual(["GET /v1/models"]);
  });
});
