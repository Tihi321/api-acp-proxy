import { ProxyController } from "./controller.js";

const controller = new ProxyController();
const announcedLoginUrls = new Map<string, string>();
controller.on("status", (status: ReturnType<ProxyController["status"]>) => {
  for (const provider of status.providers) {
    if (!provider.loginUrl) { announcedLoginUrls.delete(provider.id); continue; }
    if (announcedLoginUrls.get(provider.id) === provider.loginUrl) continue;
    announcedLoginUrls.set(provider.id, provider.loginUrl);
    console.log(`[${provider.id}] Login URL (open it in a browser only if ${provider.name} reports that login is required): ${provider.loginUrl}`);
  }
});
const status = await controller.start();
if (status.server.state === "error") { console.error(`Unable to start: ${status.server.error?.message}`); process.exitCode = 1; await controller.stop(); }
else {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    await controller.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
