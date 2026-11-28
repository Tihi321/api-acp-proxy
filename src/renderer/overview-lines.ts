import { formatUsd } from "./cost-format.js";
import type { LocalServerStatusView, ProviderStatusView, UsageCountsView } from "../shared/ipc.js";

const compactCount = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** OD6. "Today: 12 requests · ≈ 34.5K tokens · 1 error · $0.0123". Undefined when there are no counts or 0 requests. `count` formats a number (default: compact Intl). */
export function todayUsageLine(counts: UsageCountsView | undefined, count: (value: number) => string = (value) => compactCount.format(value)): string | undefined {
  if (!counts || counts.requests <= 0) return undefined;
  const parts = [
    `${count(counts.requests)} ${counts.requests === 1 ? "request" : "requests"}`,
    `${counts.estimated > 0 ? "≈ " : ""}${count(counts.inputTokens + counts.outputTokens)} tokens`,
  ];
  if (counts.errors > 0) parts.push(`${count(counts.errors)} ${counts.errors === 1 ? "error" : "errors"}`);
  if (counts.costUsd > 0) parts.push(formatUsd(counts.costUsd));
  return `Today: ${parts.join(" · ")}`;
}

/** The state line of a local provider row (no DOM). */
export function localProviderLine(input: {
  id: "gufo" | "strata" | "llama" | "ollama";
  status: ProviderStatusView | undefined;
  launcher?: LocalServerStatusView;
  profileLabel?: string;
  serverRunning: boolean;
  ollamaUrl?: string;
}): string {
  const { id, status, launcher, profileLabel, serverRunning, ollamaUrl } = input;
  if (!status || status.state === "disabled") return "Off. Turn it on on its page.";
  if (id !== "ollama") {
    switch (launcher?.state) {
      case "ready": return `Running${profileLabel ? ` ${profileLabel}` : ""}${launcher.port ? ` on port ${launcher.port}` : ""}.`;
      case "starting": return "Starting…";
      case "error": return launcher.error ?? "The server failed to start.";
      default: return "Stopped. Start it on its page.";
    }
  }
  if (!serverRunning) return "The server is not running.";
  if (status.state === "ready") return `Reachable at ${ollamaUrl}.`;
  if (status.error) return status.error;
  return "Not checked yet.";
}

/** The data-ov-focus key to focus after the Overview rows are rebuilt: the same button when it is still enabled, else that row's Settings button, else none. Keys are "<id>:login" | "<id>:logout" | "<id>:settings". */
export function overviewFocusTarget(previous: string | undefined, buttons: ReadonlyArray<{ key: string; disabled: boolean }>): string | undefined {
  if (!previous) return undefined;
  const enabled = (key: string): boolean => buttons.some((button) => button.key === key && !button.disabled);
  if (enabled(previous)) return previous;
  const settings = `${previous.slice(0, previous.lastIndexOf(":"))}:settings`;
  return enabled(settings) ? settings : undefined;
}
