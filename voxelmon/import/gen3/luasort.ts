// Port of LuaJIT 2.1 src/lib_table.c table.sort (auxsort), for the gen1recomp
// FireRed port (GPLv3 + additional terms; see LICENSE.md). LuaJIT is MIT
// (Copyright (C) 2005-2023 Mike Pall); its quicksort is Lua 5.1's.
//
// Brian's importer sorts with comparators that tie, or are not even a strict
// weak order (quantize_lab's light-to-dark centroid sort uses an |dL| < 1
// threshold). JS Array.prototype.sort orders those differently, so every
// gen3 port of a Lua `table.sort` whose order can reach output goes through
// luaSort: the same median-of-three quicksort, the same comparisons in the
// same order, the same "invalid order function for sorting" error.

/** a < b, as the Lua comparator answers it (truthy -> true). */
export type LuaLess<T> = (a: T, b: T) => boolean;

/** The default comparator: lua_lessthan on numbers or byte strings. */
function defaultLess<T>(a: T, b: T): boolean {
  if (typeof a === "number" && typeof b === "number") return a < b;
  if (typeof a === "string" && typeof b === "string") return a < b;
  throw new Error(`attempt to compare ${typeof a} with ${typeof b}`);
}

/**
 * table.sort(t[, comp]) on a 0-based JS array holding the Lua sequence
 * t[1..n] (t[i] is arr[i - 1]). Sorts in place and returns the array.
 */
export function luaSort<T>(arr: T[], comp?: LuaLess<T>): T[] {
  const lt: LuaLess<T> = comp ?? defaultLess;
  // 1-based accessors over the 0-based array
  const get = (i: number): T => arr[i - 1]!;
  const set = (i: number, v: T): void => { arr[i - 1] = v; };

  // lib_table.c auxsort(L, l, u)
  const auxsort = (l: number, u: number): void => {
    while (l < u) { // for tail recursion
      let i: number, j: number;
      // sort elements a[l], a[(l+u)/2] and a[u]
      {
        const al = get(l), au = get(u);
        if (lt(au, al)) { set(l, au); set(u, al); } // a[u] < a[l]? swap
      }
      if (u - l === 1) break; // only 2 elements
      i = Math.floor((l + u) / 2);
      {
        const ai = get(i), al = get(l);
        if (lt(ai, al)) { set(i, al); set(l, ai); } // a[i] < a[l]?
        else {
          const au = get(u);
          if (lt(au, ai)) { set(i, au); set(u, ai); } // a[u] < a[i]?
        }
      }
      if (u - l === 2) break; // only 3 elements
      const P = get(i); // pivot
      {
        const au1 = get(u - 1);
        set(i, au1); set(u - 1, P);
      }
      // a[l] <= P == a[u-1] <= a[u], only need to sort from l+1 to u-2
      i = l; j = u - 1;
      for (;;) { // invariant: a[l..i] <= P <= a[j..u]
        // repeat ++i until a[i] >= P
        let ai: T;
        for (;;) {
          ai = get(++i);
          if (!lt(ai, P)) break;
          if (i >= u) throw new Error("invalid order function for sorting");
        }
        // repeat --j until a[j] <= P
        let aj: T;
        for (;;) {
          aj = get(--j);
          if (!lt(P, aj)) break;
          if (j <= l) throw new Error("invalid order function for sorting");
        }
        if (j < i) break;
        set(i, aj); set(j, ai);
      }
      {
        const au1 = get(u - 1), ai = get(i);
        set(u - 1, ai); set(i, au1); // swap pivot (a[u-1]) with a[i]
      }
      // a[l..i-1] <= a[i] == P <= a[i+1..u]
      // adjust so that smaller half is in [j..i] and larger one in [l..u]
      if (i - l < u - i) {
        j = l; i = i - 1; l = i + 2;
      } else {
        j = i + 1; i = u; u = j - 2;
      }
      auxsort(j, i); // call recursively the smaller one
    } // repeat the routine for the larger one
  };

  auxsort(1, arr.length);
  return arr;
}

export default luaSort;
