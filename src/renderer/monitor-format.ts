/** Pure helpers of the Monitor page (no DOM, so the tests config can load them; AAP-51). */
export const GIB = 1024 ** 3;
export const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export const SPARK_W = 59;
export const SPARK_H = 16;

/**
 * The geometry of a sparkline of Strata's last 60 s. Newest point on the right; a `null` breaks the line. Undefined when the series has fewer than two numbers. A flat series draws on the baseline at the scale's minimum, at the top at a given maximum, else at mid-height.
 */
export function sparkGeometry(values: readonly (number | null)[] | undefined, opts: { min?: number | undefined; max?: number | undefined } = {}): { lines: string[]; dots: string[] } | undefined {
  if (!values) return undefined;
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length < 2) return undefined;
  const min = opts.min ?? Math.min(...numbers);
  const max = opts.max ?? Math.max(...numbers);
  const span = max - min;
  const shift = SPARK_W - (values.length - 1);
  const flat = numbers.every((value) => value === numbers[0]);
  // A flat series sits on the baseline at the scale's minimum, at the top at a given maximum, and mid-height only when neither bound says where it is.
  const flatY = (value: number): number => (opts.min !== undefined && value <= opts.min ? SPARK_H : opts.max !== undefined && value >= opts.max ? 0 : SPARK_H / 2);
  const y = (value: number): number => (flat || !(span > 0) || !Number.isFinite(span) ? flatY(value) : SPARK_H - ((Math.min(max, Math.max(min, value)) - min) / span) * SPARK_H);
  const lines: string[] = [];
  const dots: string[] = [];
  // A run of one number (between two gaps) is drawn as a dot: a short line 1 unit wide, round-capped by the CSS.
  let run: { x: number; y: string }[] = [];
  const flush = (): void => {
    const [only] = run;
    if (run.length >= 2) lines.push(run.map((point) => `${point.x},${point.y}`).join(" "));
    else if (only) { const from = Math.min(Math.max(only.x - 0.5, 0), SPARK_W - 1); dots.push(`${from},${only.y} ${from + 1},${only.y}`); } // 1 unit long, kept inside the viewBox
    run = [];
  };
  values.forEach((value, index) => {
    if (typeof value === "number" && Number.isFinite(value)) run.push({ x: index + shift, y: y(value).toFixed(2) }); else flush();
  });
  flush();
  return { lines, dots };
}

export interface SpeedSubInput { llama: boolean; value: number | undefined; haveSpeed: boolean; missingText: string; noRequest: boolean; speedMissing?: "no-metrics" | "no-request" | "metrics-unread"; external: boolean; fallback: string | undefined }
/** The sub line of the Decode and Prefill tiles. */
export function speedSub(input: SpeedSubInput): string | undefined {
  if (input.llama) {
    if (input.value !== undefined) return "average since the model started";
    if (input.haveSpeed) return input.missingText;
    if (input.speedMissing === "no-request") return "no request yet";
    if (input.speedMissing === "metrics-unread") return "speed not read this time";
    return input.external ? "start llama-server with --metrics for speed" : "restart the model for speed";
  }
  if (input.value !== undefined) return undefined;
  if (input.haveSpeed) return input.missingText;
  return input.noRequest ? "no request yet" : input.fallback;
}
