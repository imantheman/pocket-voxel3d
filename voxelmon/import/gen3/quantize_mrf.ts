// Port of gen1recomp src/import/gba/quantize_mrf.lua (GPLv3 + additional terms; see LICENSE.md).
// Multi-label Potts MRF via alpha-expansion + Dinic max-flow.
// Assigns Gen2 codebook indices to 8x8 quads with edge-gated spatial smoothness.
// Mid reuse: majority vote across map placements (known limitation).
//
// Shapes: graph node and edge ids keep the Lua's 1-based numbering (arrays
// indexed by id, slot 0 unused). Placement / node / label lists are 0-based
// JS arrays (labels[i - 1] is the Lua's labels[i]); the label VALUES are the
// Lua's 1-based codebook indices; a node's data[li - 1] is its cost for label li.

import { QuantizeLab, type CodebookEntry, type AssignOpts } from "./quantize_lab.ts";
import { tostring } from "./lua.ts";

export interface Dinic {
  head: number[]; to: number[]; rev: number[]; cap: number[]; next: number[]; n: number; e: number;
}
export interface MrfNode { data: number[]; buf?: number[] }
export interface MrfEdge { a: number; b: number; lam: number }
export interface Placement {
  buf: number[];
  pal?: number[];
  category?: string;
  gx?: number;
  gy?: number;
  mapId?: string | number;
  mid?: number | string;
  q?: number | string;
  ord?: number;
}
export interface MrfOpts {
  lambda?: number;
  edgeDe?: number;
  enabled?: boolean;
  pair?: string;
  expansions?: number;
}

// ---------------------------------------------------------------- Dinic max-flow

// Lua: quantize_mrf.lua:19
function dinic_new(): Dinic {
  return { head: [], to: [], rev: [], cap: [], next: [], n: 0, e: 0 };
}

// Lua: quantize_mrf.lua:23
function dinic_add_node(g: Dinic): number {
  g.n = g.n + 1;
  g.head[g.n] = 0;
  return g.n;
}

// Lua: quantize_mrf.lua:29
function dinic_link(g: Dinic, a: number, b: number, cap: number): number {
  g.e = g.e + 1;
  const ei = g.e;
  g.to[ei] = b;
  g.cap[ei] = cap;
  g.next[ei] = g.head[a] ?? 0;
  g.head[a] = ei;
  return ei;
}

// Lua: quantize_mrf.lua:39
function dinic_add_edge_pair(g: Dinic, u: number, v: number, cap_uv: number, cap_vu: number): void {
  const e1 = dinic_link(g, u, v, cap_uv);
  const e2 = dinic_link(g, v, u, cap_vu);
  g.rev[e1] = e2;
  g.rev[e2] = e1;
}

// Lua: quantize_mrf.lua:46
function dinic_add_tweights(g: Dinic, i: number, cap_source: number | undefined, cap_sink: number | undefined, src: number, snk: number): void {
  if (cap_source !== undefined && cap_source > 0) dinic_add_edge_pair(g, src, i, cap_source, 0);
  if (cap_sink !== undefined && cap_sink > 0) dinic_add_edge_pair(g, i, snk, cap_sink, 0);
}

// Lua: quantize_mrf.lua:55
function dinic_maxflow(g: Dinic, src: number, snk: number): number {
  const level: number[] = [], iter: number[] = [];

  const bfs = (): boolean => {
    for (let i = 1; i <= g.n; i++) level[i] = -1;
    const q = [src];
    let qh = 0;
    level[src] = 0;
    while (qh < q.length) {
      const v = q[qh]!;
      qh = qh + 1;
      let e = g.head[v]!;
      while (e !== 0) {
        const w = g.to[e]!;
        if (g.cap[e]! > 0 && level[w]! < 0) {
          level[w] = level[v]! + 1;
          q.push(w);
        }
        e = g.next[e]!;
      }
    }
    return level[snk]! >= 0;
  };

  const dfs = (v: number, f: number): number => {
    if (v === snk) return f;
    let e = iter[v]!;
    while (e !== 0) {
      const w = g.to[e]!;
      if (g.cap[e]! > 0 && level[v]! < level[w]!) {
        const d = dfs(w, Math.min(f, g.cap[e]!));
        if (d > 0) {
          g.cap[e] = g.cap[e]! - d;
          g.cap[g.rev[e]!] = g.cap[g.rev[e]!]! + d;
          return d;
        }
      }
      e = g.next[e]!;
      iter[v] = e;
    }
    return 0;
  };

  let flow = 0;
  while (bfs()) {
    for (let i = 1; i <= g.n; i++) iter[i] = g.head[i] ?? 0;
    for (;;) {
      const f = dfs(src, 1e100);
      if (f <= 0) break;
      flow = flow + f;
    }
  }
  return flow;
}

// Lua: quantize_mrf.lua:109
function dinic_in_source_set(g: Dinic, src: number, node: number): boolean {
  const seen: boolean[] = [];
  const q = [src];
  let qh = 0;
  seen[src] = true;
  while (qh < q.length) {
    const v = q[qh]!;
    qh = qh + 1;
    if (v === node) return true;
    let e = g.head[v]!;
    while (e !== 0) {
      const w = g.to[e]!;
      if (g.cap[e]! > 0 && !seen[w]) {
        seen[w] = true;
        q.push(w);
      }
      e = g.next[e]!;
    }
  }
  return false;
}

// ---------------------------------------------------------------- Potts + seam gating

// Lua: quantize_mrf.lua:133
function potts(a: number, b: number, lam: number): number {
  if (a === b) return 0;
  return lam;
}

// Lua: quantize_mrf.lua:138 (bufA/bufB 0-based: the Lua's bufA[y * 8 + 8] is bufA[y * 8 + 7])
function seam_de(bufA: number[], bufB: number[], dir: string): number {
  let sum = 0, n = 0;
  if (dir === "E") {
    for (let y = 0; y < 8; y++) {
      sum = sum + QuantizeLab.pixelDeltaE(bufA[y * 8 + 7] ?? 0, bufB[y * 8] ?? 0);
      n = n + 1;
    }
  } else {
    for (let x = 1; x <= 8; x++) {
      sum = sum + QuantizeLab.pixelDeltaE(bufA[7 * 8 + x - 1] ?? 0, bufB[x - 1] ?? 0);
      n = n + 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

// Lua: quantize_mrf.lua:154
function edge_lambda(bufA: number[], bufB: number[], dir: string, baseLam: number, edgeDe: number): number {
  if (seam_de(bufA, bufB, dir) >= edgeDe) return 0;
  return baseLam;
}

// ---------------------------------------------------------------- alpha-expansion (Kolmogorov add_term2)

// Lua: quantize_mrf.lua:163
function alpha_expand_once(nodes: MrfNode[], edges: MrfEdge[], labels: number[], alpha: number): boolean {
  const n = nodes.length;
  const g = dinic_new();
  const src = dinic_add_node(g);
  const snk = dinic_add_node(g);
  const gid: (number | undefined)[] = []; // gid[i] for node i (1-based)

  // Binary: S-set (source-reachable) -> take alpha; T-set -> keep old label.
  for (let i = 1; i <= n; i++) {
    if (labels[i - 1] !== alpha) {
      gid[i] = dinic_add_node(g);
      const keep = nodes[i - 1]!.data[labels[i - 1]! - 1] ?? 0;
      const take = nodes[i - 1]!.data[alpha - 1] ?? 0;
      dinic_add_tweights(g, gid[i]!, keep, take, src, snk);
    }
  }

  const add_term2 = (x: number, y: number, A: number, B: number, C: number, D: number): void => {
    // E00=A E01=B E10=C E11=D; require A+D <= B+C
    if (A + D > B + C + 1e-6) return;
    dinic_add_tweights(g, x, D, A, src, snk);
    B = B - A;
    C = C - D;
    if (B < 0) {
      dinic_add_tweights(g, x, 0, -B, src, snk);
      dinic_add_tweights(g, y, 0, -B, src, snk);
      B = 0;
    }
    if (C < 0) {
      dinic_add_tweights(g, x, -C, 0, src, snk);
      dinic_add_tweights(g, y, -C, 0, src, snk);
      C = 0;
    }
    if (B > 0 || C > 0) dinic_add_edge_pair(g, x, y, B, C);
  };

  for (const ed of edges) {
    const i = ed.a, j = ed.b, eLam = ed.lam;
    if (eLam > 0) {
      const Li = labels[i - 1]!, Lj = labels[j - 1]!;
      const E00 = potts(Li, Lj, eLam);
      const E01 = potts(Li, alpha, eLam);
      const E10 = potts(alpha, Lj, eLam);
      const E11 = 0;
      if (Li === alpha && Lj === alpha) {
        // both frozen
      } else if (Li === alpha) {
        if (gid[j] !== undefined) dinic_add_tweights(g, gid[j]!, E10, E11, src, snk);
      } else if (Lj === alpha) {
        if (gid[i] !== undefined) dinic_add_tweights(g, gid[i]!, E01, E11, src, snk);
      } else if (gid[i] !== undefined && gid[j] !== undefined) {
        add_term2(gid[i]!, gid[j]!, E00, E01, E10, E11);
      }
    }
  }

  dinic_maxflow(g, src, snk);

  let changed = false;
  for (let i = 1; i <= n; i++) {
    if (gid[i] !== undefined && dinic_in_source_set(g, src, gid[i]!) && labels[i - 1] !== alpha) {
      labels[i - 1] = alpha;
      changed = true;
    }
  }
  return changed;
}

export const QuantizeMrf = {
  // Locked after synthetic lambda/EDGE_DE sweep (coupled knobs).
  LAMBDA: 40.0,
  EDGE_DE: 18.0,
  EXPANSIONS: 3,
  ENABLED: false,

  // Lua: quantize_mrf.lua:233
  expand(nodes: MrfNode[], edges: MrfEdge[], labels: (number | undefined)[], nLabels: number, expansions?: number): number[] {
    expansions = expansions ?? QuantizeMrf.EXPANSIONS;
    for (let i = 0; i < nodes.length; i++) {
      if (labels[i] === undefined) labels[i] = 1;
    }
    const lab = labels as number[];
    for (let it = 0; it < expansions; it++) {
      let any = false;
      for (let alpha = 1; alpha <= nLabels; alpha++) {
        if (alpha_expand_once(nodes, edges, lab, alpha)) any = true;
      }
      if (!any) break;
    }
    return lab;
  },

  /**
   * Lua: quantize_mrf.lua:252 -- [labels (0-based list of 1-based codebook
   * indices), stats]. NOT FAITHFUL: stats.ms is wall-clock (Date.now) where
   * the Lua uses os.clock (CPU time); it is diagnostics only.
   */
  assignPlacements(placements: Placement[], codebook: CodebookEntry[], opts?: MrfOpts): [number[], Record<string, unknown>] {
    opts = opts ?? {};
    const lam = opts.lambda ?? QuantizeMrf.LAMBDA;
    const edgeDe = opts.edgeDe ?? QuantizeMrf.EDGE_DE;
    let enabled = opts.enabled;
    if (enabled === undefined) enabled = QuantizeMrf.ENABLED;
    const pair = opts.pair ?? "";
    const nLab = codebook.length;
    if (nLab === 0 || placements.length === 0) {
      return [[], { nodes: 0, labels: 0, ms: 0, mode: "empty" }];
    }

    const t0 = Date.now();
    const nodes: MrfNode[] = [], labels: number[] = [];
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      let reqCat: string | undefined;
      if (p.category && QuantizeLab.terrainFamily(p.category)) reqCat = p.category;
      const assignOpts: AssignOpts = {
        requireCategory: reqCat,
        itemCategory: p.category,
        crossCatPenalty: QuantizeLab.OUTDOOR_CROSS_CAT_PENALTY,
      };
      const data: number[] = [];
      for (let li = 1; li <= nLab; li++) {
        let cost = QuantizeLab.quadRampError(p.buf, p.pal, codebook[li - 1]!.ramp, codebook[li - 1]!.frlgSlot);
        if (reqCat && !QuantizeLab.entryHasCategory(codebook[li - 1], reqCat)) cost = cost + 1e6;
        // Grass/path must not soft-land on water/sand materials via MRF.
        if (p.category && QuantizeLab.OUTDOOR_GRASS_CATS[p.category]) {
          const e = codebook[li - 1]!;
          if (QuantizeLab.entryHasCategory(e, "WATER")
            || QuantizeLab.entryHasCategory(e, "SAND")
            || e.primaryCategory === "WATER"
            || e.primaryCategory === "SAND") {
            cost = cost + QuantizeLab.OUTDOOR_CROSS_CAT_PENALTY;
          }
        }
        data[li - 1] = cost;
      }
      nodes[i] = { data, buf: p.buf };
      labels[i] = QuantizeLab.bestCodebookIndex(p.buf, p.pal, codebook, pair, assignOpts);
    }

    if (!enabled) {
      return [labels, { nodes: nodes.length, labels: nLab, ms: Date.now() - t0, mode: "unary" }];
    }

    const at = new Map<string, number>();
    for (let i = 1; i <= placements.length; i++) {
      const p = placements[i - 1]!;
      if (p.gx !== undefined && p.gy !== undefined) {
        const key = tostring(p.mapId ?? "") + ":" + tostring(p.gx) + "," + tostring(p.gy);
        at.set(key, i);
      }
    }

    const edges: MrfEdge[] = [];
    const link = (a: number, b: number, dir: string): void => {
      if (a > b) return;
      edges.push({ a, b, lam: edge_lambda(placements[a - 1]!.buf, placements[b - 1]!.buf, dir, lam, edgeDe) });
    };
    for (let i = 1; i <= placements.length; i++) {
      const p = placements[i - 1]!;
      if (p.gx !== undefined && p.gy !== undefined) {
        const base = tostring(p.mapId ?? "") + ":";
        const east = at.get(base + tostring(p.gx + 1) + "," + tostring(p.gy));
        const south = at.get(base + tostring(p.gx) + "," + tostring(p.gy + 1));
        if (east !== undefined) link(i, east, "E");
        if (south !== undefined) link(i, south, "S");
      }
    }

    QuantizeMrf.expand(nodes, edges, labels, nLab, opts.expansions);

    return [labels, { nodes: nodes.length, edges: edges.length, labels: nLab, ms: Date.now() - t0, mode: "mrf" }];
  },

  /**
   * Lua: quantize_mrf.lua:342 -- Majority label per (mid, q); stable tie-break
   * by earliest ord. Returns out[mid][q] = label.
   */
  majorityPerMid(placements: Placement[], labels: number[]): Record<string, Record<string, number>> {
    interface Tally { counts: Map<number, number>; best: number; bestN: number; bestOrd: number }
    const tallies = new Map<unknown, Map<unknown, Tally>>();
    for (let i = 1; i <= placements.length; i++) {
      const p = placements[i - 1]!;
      const mid = p.mid, q = p.q, lab = labels[i - 1]!;
      if (!tallies.has(mid)) tallies.set(mid, new Map());
      const qs = tallies.get(mid)!;
      let t = qs.get(q);
      if (!t) {
        t = { counts: new Map(), best: lab, bestN: 0, bestOrd: p.ord ?? i };
        qs.set(q, t);
      }
      t.counts.set(lab, (t.counts.get(lab) ?? 0) + 1);
      const n = t.counts.get(lab)!, ord = p.ord ?? i;
      if (n > t.bestN
        || (n === t.bestN && lab < t.best)
        || (n === t.bestN && lab === t.best && ord < t.bestOrd)) {
        t.best = lab; t.bestN = n; t.bestOrd = ord;
      }
    }
    const out: Record<string, Record<string, number>> = {};
    for (const [mid, qs] of tallies) {
      const row: Record<string, number> = {};
      out[String(mid)] = row;
      for (const [q, t] of qs) row[String(q)] = t.best;
    }
    return out;
  },

  _dinic_new: dinic_new,
  _dinic_add_node: dinic_add_node,
  _dinic_add_edge_pair: dinic_add_edge_pair,
  _dinic_add_tweights: dinic_add_tweights,
  _dinic_maxflow: dinic_maxflow,
  _dinic_in_source_set: dinic_in_source_set,
  _seam_de: seam_de,
  _alpha_expand_once: alpha_expand_once,
};

export default QuantizeMrf;
