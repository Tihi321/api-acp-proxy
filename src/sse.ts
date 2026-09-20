import type { ServerResponse } from "node:http";

export function beginSse(response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
}

export function writeSse(response: ServerResponse, data: unknown, event?: string): void {
  if (event) response.write(`event: ${event}\n`);
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of serialized.split("\n")) response.write(`data: ${line}\n`);
  response.write("\n");
}

export function endSse(response: ServerResponse): void {
  response.write("data: [DONE]\n\n");
  response.end();
}
