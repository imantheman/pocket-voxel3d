// gen1recomp src/core/Logger.lua (bdfac727): a minimal logger that keeps the
// last 200 lines. `format` is Lua's string.format for the %s/%d/%x/%q the
// engine's call sites use. Lines go to `Logger.sink` (the entry points it at
// the host's log) as well as the history.

import { format } from "../../platform/lua.ts";

export const Logger = {
  history: [] as string[],
  sink: null as ((line: string) => void) | null,

  info(fmt: string, ...args: unknown[]): void {
    emit("info", fmt, args);
  },
  warn(fmt: string, ...args: unknown[]): void {
    emit("warn", fmt, args);
  },
  error(fmt: string, ...args: unknown[]): void {
    emit("error", fmt, args);
  },
};

function emit(level: string, fmt: string, args: unknown[]): void {
  const msg = args.length > 0 ? format(fmt, ...args) : String(fmt);
  const line = `[${level}] ${msg}`;
  Logger.sink?.(line);
  Logger.history.push(line);
  if (Logger.history.length > 200) Logger.history.shift();
}

export default Logger;
