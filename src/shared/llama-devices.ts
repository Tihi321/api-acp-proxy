// AAP-58: the GPUs `llama-server --list-devices` finds.

/** The device lines after "Available devices:" (`[]` for `(none)`); undefined when the output has no such header. */
export function parseDevices(output: string): string[] | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Available devices:\s*$/.test(line));
  if (start < 0) return undefined;
  const devices: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const text = line.trim();
    if (text !== "(none)") devices.push(text);
  }
  return devices;
}
