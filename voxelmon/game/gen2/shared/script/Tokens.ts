// gen1recomp src/script/Tokens.lua (bdfac727): expand {NAME} / {NAME:arg}
// text tokens through a handler table.

import { Logger } from "../core/Logger.ts";

export type TokenHandler = (game: any, arg?: string) => string | null | undefined;

const warned = new Set<string>();

export const Tokens = {
  warnOnce(name: string): void {
    if (warned.has(name)) return;
    warned.add(name);
    Logger.warn("unknown text token {%s}", name);
  },

  expand(game: any, text: string, handlers?: Record<string, TokenHandler> | null): string {
    const h = handlers ?? game?.data?.tokens;
    if (!h) return text;
    return text.replace(/\{(\w+):?([\w:]*)\}/g, (_m, name: string, arg: string) => {
      const fn = h[name];
      if (!fn) {
        Tokens.warnOnce(name);
        return "";
      }
      try {
        return fn(game, arg !== "" ? arg : undefined) ?? "";
      } catch (e) {
        Logger.error("token {%s}: %s", name, String(e));
        return "";
      }
    });
  },
};

export default Tokens;
