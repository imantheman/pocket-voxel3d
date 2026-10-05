// Port of gen1recomp src/core/Logger.lua (GPLv3 + additional terms; see LICENSE.md).
// Minimal logger; warnings are collected so debug overlays can show them.
// `print` is console.log (the host routes it to its log).

import { format } from "../../../../import/gen3/lua.ts";
import { insert, len, remove } from "../../platform/lt.ts";

const history: (string | null)[] = [null];

// Lua: Logger.lua:5
function emit(level: string, fmt: string, args: unknown[]): void {
  const msg = args.length > 0 ? format(fmt, ...args) : fmt;
  const line = format("[%s] %s", level, msg);
  console.log(line);
  insert(Logger.history, line);
  if (len(Logger.history) > 200) {
    remove(Logger.history, 1);
  }
}

export const Logger = {
  /** A sequence (slot 0 unused) of the last 200 lines. */
  history,
  // Lua: Logger.lua:15
  info(fmt: string, ...args: unknown[]): void { emit("info", fmt, args); },
  // Lua: Logger.lua:16
  warn(fmt: string, ...args: unknown[]): void { emit("warn", fmt, args); },
  // Lua: Logger.lua:17
  error(fmt: string, ...args: unknown[]): void { emit("error", fmt, args); },
};

export default Logger;
