import { describe, expect, it } from "vitest";
import { listMcpServers } from "../src/mcp-servers.js";

describe("listMcpServers (the read-only list of the settings window)", () => {
  it("lists the configured servers by label with transport and target", () => {
    expect(listMcpServers({
      zeta: { url: "https://example.com/mcp", headers: { authorization: "Bearer SECRET-HEADER" } },
      alpha: { command: "npx", args: ["-y", "some-server", "--token", "SECRET-ARG"], env: { TOKEN: "SECRET-ENV" } },
      mid: { url: "http://localhost:9000/sse", transport: "sse" },
    })).toEqual([
      { label: "alpha", transport: "stdio", target: "npx" },
      { label: "mid", transport: "sse", target: "http://localhost:9000/sse" },
      { label: "zeta", transport: "http", target: "https://example.com/mcp" },
    ]);
  });

  it("never shows headers, env, arguments, credentials or a query string", () => {
    const text = JSON.stringify(listMcpServers({
      one: { url: "https://user:SECRET-PASS@example.com/mcp?token=SECRET-QUERY#SECRET-HASH", headers: { "x-api-key": "SECRET-HEADER" } },
      two: { command: "node", args: ["--key=SECRET-ARG"], env: { KEY: "SECRET-ENV" } },
    }));
    expect(text).not.toContain("SECRET");
    expect(text).toContain("https://example.com/mcp");
  });

  it("is empty without servers", () => {
    expect(listMcpServers({})).toEqual([]);
    expect(listMcpServers()).toEqual([]);
  });
});
