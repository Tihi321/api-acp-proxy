"use strict";
// Loaded with `node --require` in agent child processes (ELECTRON_RUN_AS_NODE). Makes `windowsHide` default to true
// so that console-subsystem children (codex.exe and friends) do not flash a console window under a GUI parent.
if (process.platform === "win32") {
  const cp = require("node:child_process");
  const patch = (name, optionsIndexFor) => {
    const original = cp[name];
    if (typeof original !== "function") return;
    cp[name] = function patched(...args) {
      const index = optionsIndexFor(args);
      const current = args[index];
      if (current === undefined || current === null || typeof current === "function") {
        // options omitted: insert a fresh object before a trailing callback if there is one.
        const options = { windowsHide: true };
        if (typeof current === "function") args.splice(index, 0, options); else args[index] = options;
      } else if (typeof current === "object" && current.windowsHide === undefined) {
        args[index] = { ...current, windowsHide: true };
      }
      return original.apply(this, args);
    };
    // keep util.promisify custom behaviour (execFile) intact
    for (const key of Object.getOwnPropertySymbols(original)) {
      Object.defineProperty(cp[name], key, Object.getOwnPropertyDescriptor(original, key));
    }
  };
  // spawn(cmd, [args], [options]) / spawnSync / execFile(file, [args], [options], [cb]) / execFileSync / fork(module, [args], [options])
  const afterArgs = (args) => (Array.isArray(args[1]) ? 2 : 1);
  patch("spawn", afterArgs);
  patch("spawnSync", afterArgs);
  patch("execFileSync", afterArgs);
  patch("fork", afterArgs);
  patch("execFile", afterArgs); // a callback in the options slot means options were omitted
  // exec(command, [options], [cb]) / execSync(command, [options])
  patch("exec", () => 1);
  patch("execSync", () => 1);
  require("node:module").syncBuiltinESMExports();
}
