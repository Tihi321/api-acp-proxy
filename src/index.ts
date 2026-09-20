import { createProxyServer } from "./server.js";
import { AcpBridge } from "./acp.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const bridge = new AcpBridge(config);
const server = createProxyServer(config, bridge);
server.listen(config.port, config.host, () => console.log(`Codex subscription proxy listening on http://${config.host}:${config.port}`));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await bridge.close();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
