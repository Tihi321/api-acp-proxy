/** A label names an MCP server: it becomes the server name in `session/new` and part of the tool names the agents show the model. */
export const MCP_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
/** An HTTP header name (RFC 9110 token). */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A header value or environment value must not contain line breaks or NUL. */
export const plainValue = (value: string): boolean => !/[\r\n\0]/.test(value);
/** A tool name in `allowed_tools` / `never.tool_names`: no spaces, no `*`, no parentheses (Claude's `allowedTools` rules use them as syntax). */
export const TOOL_FILTER_NAME = /^[^\s*()]{1,128}$/;

export type McpTransport = "http" | "sse" | "stdio";
/** One remote MCP server of a request, after the request's tool entry was matched with the settings. `allowedTools` is the tools the agent may call (undefined: all). */
export interface McpServerSpec {
  label: string;
  transport: McpTransport;
  /** http and sse. */
  url?: string;
  headers: Array<{ name: string; value: string }>;
  /** stdio. */
  command?: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  allowedTools?: string[];
}
