// gen1recomp src/core/Strings.lua (bdfac727): the translation table. Only
// the English source strings exist here, so every lookup is the identity --
// `Strings.source` marks a literal as translatable (Strings.lua:128) and
// `Strings.get` formats it (Strings.lua:90).

import { format } from "../../platform/lua.ts";

export const Strings = {
  load(_data?: unknown): void {},
  active(): null {
    return null;
  },
  lookup(source: string, _context?: string): string {
    return source;
  },
  get(source: string, ...args: unknown[]): string {
    return args.length > 0 ? format(source, ...args) : source;
  },
  source<T>(text: T): T {
    return text;
  },
};

export default Strings;
