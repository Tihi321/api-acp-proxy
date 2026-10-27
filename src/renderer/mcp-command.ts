// Pure helpers for the "MCP" line of the Overview (no DOM, no secrets): the endpoint of the proxy's MCP server and the command that registers it in Claude Code.

/** The MCP endpoint for the API base URL shown in the Overview (it already ends in `/v1`): `http://127.0.0.1:8787/v1` becomes `http://127.0.0.1:8787/v1/mcp`. */
export const mcpEndpointUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/mcp`;

/** What the user pastes into a terminal. With an API key set, the header carries a placeholder: the real key is never put on the clipboard. */
export const mcpAddCommand = (baseUrl: string, keySet: boolean): string =>
  `claude mcp add --transport http acp-proxy ${mcpEndpointUrl(baseUrl)}${keySet ? ' --header "Authorization: Bearer <your key>"' : ""}`;
