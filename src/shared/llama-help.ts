// AAP-56: which flags the active llama-server build lists in `--help`, and which flags of a profile's Extra arguments it does not.

/** Every flag (short, long, aliases, `--no-` forms) on the option lines of `llama-server --help`. */
export function parseHelpFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const line of helpText.split(/\r?\n/)) {
    if (!line.startsWith("-")) continue; // option lines start in column 0; descriptions are indented
    let rest = line;
    for (;;) {
      const flag = /^-{1,2}[A-Za-z0-9][\w-]*/.exec(rest)?.[0];
      if (!flag) break;
      flags.add(flag);
      // an optional metavar (`N`, `MODE`), then a comma: another alias follows
      const next = /^(?:\s+(?!-)[^\s,]+)?\s*,\s*/.exec(rest.slice(flag.length));
      if (!next) break;
      rest = rest.slice(flag.length + next[0].length);
    }
  }
  return flags;
}

/** The arguments split at white space, a double-quoted value staying one token (quotes removed), like the shell line the launcher builds. */
export function splitArgs(args: string): string[] {
  return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/** The flags in `args` that `known` does not contain, without `=value`, each once, in order. Values and negative numbers are not flags. */
export function unknownFlags(args: string, known: Set<string>): string[] {
  const result: string[] = [];
  for (const token of splitArgs(args)) {
    if (!/^-/.test(token) || /^-\.?\d/.test(token)) continue;
    const flag = token.split("=")[0]!;
    if (flag.length > 1 && !known.has(flag) && !result.includes(flag)) result.push(flag);
  }
  return result;
}
