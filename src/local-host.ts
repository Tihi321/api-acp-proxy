import { EXCLUSIVE_SERVER_IDS, LOCAL_SERVER_NAMES, type LocalServerManager, type LocalServerSpec } from "./local-servers.js";
import { targetKey, type LocalModelHost, type LocalModelTarget } from "./local-models.js";
import type { LocalServerId } from "./shared/ipc.js";

export interface LocalSpecSource {
  /** Throws (message shown to the user) when the target cannot start: settings not loaded, build gate, missing files. */
  specFor(target: LocalModelTarget): LocalServerSpec;
  port(server: LocalServerId): number | undefined;
}

/** The server id and profile id a coordinator key stands for (`strata`, `gufo:<id>`, `llama:<id>`). */
function parseKey(key: string): { server: LocalServerId; profile?: string } {
  if (key === "strata") return { server: "strata" };
  const index = key.indexOf(":");
  const server = key.slice(0, index) as LocalServerId;
  return { server, profile: key.slice(index + 1) };
}

/** Plain-Node host for the coordinator: maps target keys to launcher entries. One server runs at a time (the manager enforces it). */
export function createLocalModelHost(manager: LocalServerManager, specs: LocalSpecSource): LocalModelHost {
  return {
    current: () => {
      const list = manager.list();
      // The embedding server is not a coordinator target: it never counts as the active or failed server.
      const active = EXCLUSIVE_SERVER_IDS.map((id) => list.find((entry) => entry.id === id)).find((entry) => entry && (entry.state === "starting" || entry.state === "ready"));
      if (active) return { key: targetKey(active.id, active.profile), state: active.state as "starting" | "ready" };
      const failed = list.filter((entry) => entry.state === "error" && entry.id !== "embed").sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      if (failed) return { key: targetKey(failed.id, failed.profile), state: "error", error: failed.error };
      return { state: "stopped" };
    },
    start: async (target) => { await manager.start(specs.specFor(target)); },
    external: async (target) => {
      const port = specs.port(target.server);
      return port !== undefined && manager.answersExternally(target.server, port);
    },
    waitReady: (key, signal) => new Promise<void>((resolve, reject) => {
      const { server, profile } = parseKey(key);
      const name = LOCAL_SERVER_NAMES[server];
      const check = (): boolean => {
        const entry = manager.list().find((candidate) => candidate.id === server);
        if (!entry || (server !== "strata" && entry.profile !== profile)) { reject(new Error(`${name} was switched away from '${profile ?? server}' while it started.`)); return true; }
        if (entry.state === "ready") { resolve(); return true; }
        if (entry.state === "error" || entry.state === "stopped") { reject(new Error(entry.error ?? entry.log[entry.log.length - 1] ?? `${name} '${profile ?? server}' stopped before it was ready.`)); return true; }
        return false;
      };
      if (check()) return;
      const onChange = (): void => { if (check()) cleanup(); };
      const onAbort = (): void => { cleanup(); reject(new Error("Aborted")); };
      const cleanup = (): void => { manager.off("change", onChange); signal.removeEventListener("abort", onAbort); };
      manager.on("change", onChange);
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    }),
  };
}
