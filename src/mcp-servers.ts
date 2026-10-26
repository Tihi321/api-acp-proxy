import { ApiError, type McpToolRequest } from "./api.js";
import type { McpServerSpec } from "./mcp-config.js";
import type { McpServerSetting } from "./settings.js";

const asPairs = (record: Record<string, string> | undefined): Array<{ name: string; value: string }> => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
const bad = (message: string, code = "invalid_request"): ApiError => new ApiError(400, code, message, "tools");

/** The tools the agent may call: `allowed_tools` and the `never` list of `require_approval`, both when given (a tool outside either would be refused). Undefined: all. */
function toolFilter(request: McpToolRequest): string[] | undefined {
  const { allowedTools, neverTools } = request;
  if (!allowedTools) return neverTools;
  if (!neverTools) return allowedTools;
  const both = allowedTools.filter((name) => neverTools.includes(name));
  if (!both.length) throw bad(`No tool of the MCP server '${request.label}' is both in allowed_tools and in require_approval.never.tool_names.`);
  return both;
}

/**
 * Matches the `mcp` tools of a request with the settings. A tool with a `server_url` becomes a remote http server; a tool without one must name a configured label
 * (http, sse or stdio, as configured). A `server_url` cannot reuse a configured label, and a configured server takes no request headers, so a request can never
 * change what a configured server is. A stdio server only ever comes from the settings.
 */
export function resolveMcpServers(requested: McpToolRequest[], configured: Record<string, McpServerSetting> = {}): McpServerSpec[] {
  return requested.map((request): McpServerSpec => {
    const known = Object.hasOwn(configured, request.label) ? configured[request.label] : undefined;
    const allowedTools = toolFilter(request);
    const filter = allowedTools ? { allowedTools } : {};
    if (request.url !== undefined) {
      if (known) throw bad(`The label '${request.label}' is configured in the proxy's settings; send the mcp tool without server_url, or use another label.`);
      return { label: request.label, transport: "http", url: request.url, headers: asPairs(request.headers), args: [], env: [], ...filter };
    }
    if (!known) throw bad(`The mcp tool '${request.label}' needs a server_url (or a label that is configured in the proxy's settings).`);
    if (request.headers) throw bad(`The mcp tool '${request.label}' is a configured server: it takes no headers from a request.`);
    if ("command" in known) return { label: request.label, transport: "stdio", command: known.command, headers: [], args: known.args ?? [], env: asPairs(known.env), ...filter };
    return { label: request.label, transport: known.transport === "sse" ? "sse" : "http", url: known.url, headers: asPairs(known.headers), args: [], env: [], ...filter };
  });
}
