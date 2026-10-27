import { describe, expect, it } from "vitest";
import { mcpAddCommand, mcpEndpointUrl } from "../src/renderer/mcp-command.js";

describe("MCP line of the Overview", () => {
  it("builds the endpoint from the API base URL, which already ends in /v1", () => {
    expect(mcpEndpointUrl("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/v1/mcp");
    expect(mcpEndpointUrl("http://127.0.0.1:8787/v1/")).toBe("http://127.0.0.1:8787/v1/mcp");
  });

  it("copies the claude mcp add command", () => {
    expect(mcpAddCommand("http://127.0.0.1:8787/v1", false)).toBe("claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp");
  });

  it("adds a header placeholder, never a key, when an API key is set", () => {
    expect(mcpAddCommand("http://127.0.0.1:8787/v1", true)).toBe('claude mcp add --transport http acp-proxy http://127.0.0.1:8787/v1/mcp --header "Authorization: Bearer <your key>"');
  });
});
