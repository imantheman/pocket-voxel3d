// The link battle record (sLinkBattleStats: the totals and five opponents),
// as the cart keeps it: engine/link/link.asm's AddLastLinkBattleToLinkRecord
// after every COLOSSEUM battle, and _DisplayLinkRecord (ui/LinkRecord.ts) on
// the Pokecenter 2F's sign.
//
// An opponent is known by their name and trainer ID together. A new one takes
// an empty row, or else the row with the fewest battles; the rows are kept
// with the most battles first. Every count stops at 9999.

export type LinkResult = "win" | "lose" | "draw";

export interface LinkRecordRow {
  name: string;
  id: number;
  win: number;
  lose: number;
  draw: number;
}

export interface LinkRecordTable {
  win: number;
  lose: number;
  draw: number;
  rows: LinkRecordRow[];
}

export const NUM_LINK_BATTLE_RECORDS = 5;
const MAX_COUNT = 9999;

const total = (r: { win: number; lose: number; draw: number }): number => r.win + r.lose + r.draw;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export const LinkRecords = {
  /** The save's record, made whole (an old save has none). */
  of(save: any): LinkRecordTable {
    const t = save?.linkRecord;
    const rows: LinkRecordRow[] = Array.isArray(t?.rows)
      ? t.rows.filter((r: any) => r && typeof r.name === "string").slice(0, NUM_LINK_BATTLE_RECORDS).map((r: any) => ({
          name: r.name, id: num(r.id), win: num(r.win), lose: num(r.lose), draw: num(r.draw),
        }))
      : [];
    return { win: num(t?.win), lose: num(t?.lose), draw: num(t?.draw), rows };
  },

  /** AddLastLinkBattleToLinkRecord: one battle against `name`/`id`. */
  add(save: any, name: string, id: number, result: LinkResult): LinkRecordTable {
    const t = LinkRecords.of(save);
    const bump = (r: LinkRecordTable | LinkRecordRow): void => {
      r[result] = Math.min(MAX_COUNT, r[result] + 1);
    };
    bump(t);
    let row = t.rows.find((r) => r.name === name && r.id === id);
    if (!row) {
      row = { name, id, win: 0, lose: 0, draw: 0 };
      if (t.rows.length < NUM_LINK_BATTLE_RECORDS) t.rows.push(row);
      else {
        // the fewest battles makes room (the last of a tie)
        let at = 0;
        t.rows.forEach((r, i) => { if (total(r) <= total(t.rows[at]!)) at = i; });
        t.rows[at] = row;
      }
    }
    bump(row);
    // most battles first; a tie keeps its order
    t.rows = t.rows.map((r, i) => [r, i] as const).sort((a, b) => total(b[0]) - total(a[0]) || a[1] - b[1]).map(([r]) => r);
    if (save) save.linkRecord = t;
    return t;
  },
};
