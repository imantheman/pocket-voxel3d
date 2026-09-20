//! What building a map is actually going to consume, decided from the
//! 128-byte chunk records alone.
//!
//! The flat-buffer terrain path spends a fixed vertex budget in a fixed
//! order: the ground pass, then the removable stamps, then a per-chunk tree
//! cascade (fine hull if it still fits, else the coarse carve, else a plain
//! box), then water/grass/flower with whatever survives. On a dense map the
//! budget runs out long before the chunks do — Viridian Forest offers 2.9M
//! vertices against a 400,000 cap — so most of a pak's geometry is read off
//! the card and then dropped by the same budget check every single time.
//!
//! Every count that decision turns on lives in the chunk records, which sit
//! ahead of the vertex and index pools in the section. So the whole
//! allocation can be replayed before reading a single vertex, and the loader
//! can then fetch exactly the ranges that will be drawn.
//!
//! The renderer is HANDED the plan rather than re-deriving it. It has to be:
//! the border-ring clip drops triangles, so the real vertex count runs below
//! the plan's, and a re-derived cascade could choose a fine hull the loader
//! never read — drawing zeros. One decision, made once, used by both.

use crate::pak;
use crate::spec::{mesh_kind, CHUNK_PX};

/// Vertex cap for an ordinary map.
pub const MAX_VERTS: usize = 900_000;
/// Cap for a map past [`HUGE_MAP_THRESHOLD`], where a single flat buffer
/// holding every chunk would neither look right nor fit safely.
pub const MAX_VERTS_SAFE: usize = 400_000;
/// Past this many indices at full detail, a map is "huge": it takes the safe
/// cap and sorts its chunks nearest-the-player-first, so the budget is spent
/// on what is close rather than on whatever came first in file order.
pub const HUGE_MAP_THRESHOLD: usize = MAX_VERTS_SAFE * 3;

/// Drawn first, at full priority — the ground the player walks on.
pub const GROUND_KINDS: [usize; 3] = [
    mesh_kind::TERRAIN as usize,
    mesh_kind::TERRAIN_KEEP as usize,
    mesh_kind::WATER as usize,
];
/// The three tree tiers, in descending detail; the cascade picks one.
pub const TREE_KINDS: [usize; 3] = [
    mesh_kind::TREE_HULL as usize,
    mesh_kind::TREE_COARSE as usize,
    mesh_kind::TREE_BOX as usize,
];
/// Ankle-height decoration, drawn with whatever budget is left.
pub const FILLER_KINDS: [usize; 2] = [
    mesh_kind::GRASS as usize,
    mesh_kind::FLOWER as usize,
];

/// One mesh the build will consume: a chunk, and the kind it draws it at.
/// In build order — the budget is spent in that order, and which tree tier a
/// chunk gets depends on what came before it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PlanItem {
    /// Index into the map's own chunk slice.
    pub chunk: usize,
    pub kind: usize,
}

#[derive(Clone, Debug)]
pub struct BuildPlan {
    pub items: Vec<PlanItem>,
    pub huge: bool,
    pub budget: usize,
}

/// The chunk order, huge classification and budget the build will use.
///
/// `player_px` is the position the nearest-first sort centres on; it only
/// matters for a huge map. Pass the same value the build will get.
pub fn build_order(
    chunks: &[pak::Chunk],
    player_px: Option<(f32, f32)>,
) -> (Vec<usize>, bool, usize) {
    let mut total = 0usize;
    for c in chunks {
        for &k in GROUND_KINDS.iter() {
            total += c.meshes[k].index_count as usize;
        }
        total += c.meshes[mesh_kind::TREE_HULL as usize].index_count as usize;
        for &k in FILLER_KINDS.iter() {
            total += c.meshes[k].index_count as usize;
        }
    }
    let huge = total > HUGE_MAP_THRESHOLD;
    let mut order: Vec<usize> = (0..chunks.len()).collect();
    if huge {
        if let Some((px, pz)) = player_px {
            let pcx = (px / CHUNK_PX as f32).floor() as i32;
            let pcz = (pz / CHUNK_PX as f32).floor() as i32;
            order.sort_by_key(|&i| {
                let dx = chunks[i].cx as i32 - pcx;
                let dy = chunks[i].cy as i32 - pcz;
                dx * dx + dy * dy
            });
        }
    }
    (order, huge, if huge { MAX_VERTS_SAFE } else { MAX_VERTS })
}

/// Replay the allocation over the records.
///
/// `stamp_verts` is what the removable stamps (cut trees, the S.S. Anne
/// hull) will spend; they are pushed between the ground and tree passes at
/// ground priority, and live in their own section rather than in any chunk.
pub fn plan_build(
    chunks: &[pak::Chunk],
    order: &[usize],
    huge: bool,
    budget: usize,
    stamp_verts: usize,
) -> BuildPlan {
    let mut items: Vec<PlanItem> = Vec::new();
    let mut used = 0usize;
    // The renderer walks triangles and stops at `verts.len() + 3 > budget`,
    // pushing one vertex per index — so a mesh contributes min(index_count,
    // whatever is left rounded down to a whole triangle).
    let take = |used: &mut usize, items: &mut Vec<PlanItem>, chunk: usize, kind: usize| {
        let m = chunks[chunk].meshes[kind];
        if m.index_count == 0 {
            return;
        }
        let room = budget.saturating_sub(*used);
        let got = (m.index_count as usize).min(room - room % 3);
        if got == 0 {
            return;
        }
        *used += got;
        items.push(PlanItem { chunk, kind });
    };
    for &k in GROUND_KINDS.iter() {
        for &c in order {
            take(&mut used, &mut items, c, k);
        }
    }
    used = used.saturating_add(stamp_verts).min(budget);
    for &c in order {
        let hull = chunks[c].meshes[mesh_kind::TREE_HULL as usize];
        let coarse = chunks[c].meshes[mesh_kind::TREE_COARSE as usize];
        let kind = if hull.index_count > 0 && used + hull.index_count as usize <= budget {
            mesh_kind::TREE_HULL as usize
        } else if coarse.index_count > 0 && used + coarse.index_count as usize <= budget {
            mesh_kind::TREE_COARSE as usize
        } else {
            mesh_kind::TREE_BOX as usize
        };
        take(&mut used, &mut items, c, kind);
    }
    for &k in FILLER_KINDS.iter() {
        for &c in order {
            take(&mut used, &mut items, c, k);
        }
    }
    BuildPlan { items, huge, budget }
}

/// Byte ranges in the file that a plan needs, given where the two pools
/// start. Sorted and merged, so geometry that is adjacent in the pool costs
/// one seek rather than dozens.
///
/// The WHOLE vertex block of each mesh is taken: which of them the surviving
/// triangles index cannot be known without reading the indices first, and on
/// SD one contiguous run beats a seek per triangle by a wide margin.
///
/// `slop` is how far apart two runs may be and still be read as one.
pub fn planned_ranges(
    chunks: &[pak::Chunk],
    plan: &BuildPlan,
    stamps: &[pak::Stamp],
    // TINS shape meshes (Pak::tree_shapes). They live in the same pools and
    // NO CHUNK NAMES THEM, so a planned read left them as the zeros the
    // buffer was filled with: every tree instance then drew a shape whose
    // vertices were all (0, 0, 0) -- degenerate triangles, no error from the
    // GPU, and nothing on screen.
    tree_shapes: &[pak::MeshRange],
    verts_at: usize,
    indices_at: usize,
    slop: usize,
) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::with_capacity(plan.items.len() * 2 + stamps.len() * 2);
    let mut want = |m: pak::MeshRange| {
        if m.index_count == 0 {
            return;
        }
        runs.push((
            verts_at + m.vert_base as usize * 16,
            verts_at + (m.vert_base as usize + m.vert_count as usize) * 16,
        ));
        runs.push((
            indices_at + m.index_base as usize * 2,
            indices_at + (m.index_base as usize + m.index_count as usize) * 2,
        ));
    };
    for it in plan.items.iter() {
        want(chunks[it.chunk].meshes[it.kind]);
    }
    for st in stamps {
        want(st.mesh);
    }
    for m in tree_shapes {
        want(*m);
    }
    runs.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
    for (a, b) in runs {
        match merged.last_mut() {
            Some(last) if a <= last.1 + slop => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak::{Chunk, MeshRange};
    use crate::spec::MESH_KINDS;

    fn empty() -> MeshRange {
        MeshRange { vert_base: 0, vert_count: 0, index_count: 0, index_base: 0 }
    }

    fn chunk(cx: i16, cy: i16, kinds: &[(usize, u16, u32)]) -> Chunk {
        let mut meshes = [empty(); MESH_KINDS];
        for &(k, n, base) in kinds {
            meshes[k] = MeshRange {
                vert_base: base,
                vert_count: n,
                index_count: n,
                index_base: base,
            };
        }
        Chunk {
            cx,
            cy,
            aabb_min: [0; 3],
            aabb_max: [128; 3],
            bake_page: crate::spec::BAKE_PAGE_NONE,
            meshes,
        }
    }

    const HULL: usize = mesh_kind::TREE_HULL as usize;
    const COARSE: usize = mesh_kind::TREE_COARSE as usize;
    const BOX: usize = mesh_kind::TREE_BOX as usize;
    const TERRAIN: usize = mesh_kind::TERRAIN as usize;

    #[test]
    fn a_small_map_keeps_file_order_and_the_generous_cap() {
        let cs = vec![chunk(0, 0, &[(TERRAIN, 300, 0)]), chunk(1, 0, &[(TERRAIN, 300, 300)])];
        let (order, huge, budget) = build_order(&cs, Some((900.0, 0.0)));
        assert!(!huge);
        assert_eq!(budget, MAX_VERTS);
        // no nearest-first sort: position must not reorder an ordinary map
        assert_eq!(order, vec![0, 1]);
    }

    #[test]
    fn a_huge_map_sorts_nearest_first_and_drops_to_the_safe_cap() {
        // enough indices to cross HUGE_MAP_THRESHOLD
        let big = (HUGE_MAP_THRESHOLD / 2 + 9) as u16;
        let _ = big;
        let cs: Vec<Chunk> = (0..4)
            .map(|i| chunk(i as i16, 0, &[(TERRAIN, 60000, i as u32 * 60000)]))
            .collect();
        let (order, huge, budget) = build_order(&cs, Some((3.0 * CHUNK_PX as f32 + 1.0, 0.0)));
        if huge {
            assert_eq!(budget, MAX_VERTS_SAFE);
            assert_eq!(order[0], 3, "the chunk the player stands in comes first");
        }
    }

    #[test]
    fn the_tree_cascade_falls_to_coarse_then_box_as_the_budget_goes() {
        // One chunk whose hull alone would blow a tiny budget, but whose
        // coarse carve fits; and one where nothing fits but the box.
        let cs = vec![
            chunk(0, 0, &[(HULL, 600, 0), (COARSE, 150, 600), (BOX, 30, 750)]),
            chunk(1, 0, &[(HULL, 600, 780), (COARSE, 150, 1380), (BOX, 30, 1530)]),
        ];
        let order = vec![0, 1];
        // room for one hull only
        let plan = plan_build(&cs, &order, false, 900, 0);
        let kinds: Vec<usize> = plan.items.iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec![HULL, COARSE], "second chunk drops a tier");

        // room for neither
        let plan = plan_build(&cs, &order, false, 200, 0);
        let kinds: Vec<usize> = plan.items.iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec![COARSE, BOX]);
    }

    #[test]
    fn ground_is_spent_before_trees_get_a_turn() {
        let cs = vec![chunk(0, 0, &[(TERRAIN, 900, 0), (HULL, 300, 900), (BOX, 30, 1200)])];
        let plan = plan_build(&cs, &[0], false, 900, 0);
        assert_eq!(plan.items[0].kind, TERRAIN);
        // the whole budget went to ground, so the tree tier cannot be the hull
        assert!(plan.items.iter().all(|i| i.kind != HULL));
    }

    #[test]
    fn stamps_take_their_share_before_the_cascade_chooses() {
        let cs = vec![chunk(0, 0, &[(HULL, 600, 0), (COARSE, 150, 600), (BOX, 30, 750)])];
        assert_eq!(plan_build(&cs, &[0], false, 700, 0).items[0].kind, HULL);
        // the same map, with stamps already holding 400 of that budget
        assert_eq!(plan_build(&cs, &[0], false, 700, 400).items[0].kind, COARSE);
    }

    #[test]
    fn planned_ranges_cover_every_byte_the_mesh_will_touch() {
        let cs = vec![chunk(0, 0, &[(TERRAIN, 30, 5)])];
        let plan = plan_build(&cs, &[0], false, MAX_VERTS, 0);
        let r = planned_ranges(&cs, &plan, &[], &[], 1000, 9000, 0);
        // vertices [5, 35) * 16 bytes, indices [5, 35) * 2 bytes
        assert!(r.contains(&(1000 + 5 * 16, 1000 + 35 * 16)), "{r:?}");
        assert!(r.contains(&(9000 + 5 * 2, 9000 + 35 * 2)), "{r:?}");
    }

    #[test]
    fn adjacent_runs_merge_into_one_seek() {
        let cs = vec![
            chunk(0, 0, &[(TERRAIN, 10, 0)]),
            chunk(1, 0, &[(TERRAIN, 10, 10)]), // immediately after in the pool
        ];
        let plan = plan_build(&cs, &[0, 1], false, MAX_VERTS, 0);
        let r = planned_ranges(&cs, &plan, &[], &[], 0, 100_000, 0);
        let verts: Vec<_> = r.iter().filter(|&&(a, _)| a < 100_000).collect();
        assert_eq!(verts.len(), 1, "two adjacent vertex blocks should be one run");
        assert_eq!(*verts[0], (0, 20 * 16));
    }

    #[test]
    fn an_empty_mesh_is_never_read() {
        let cs = vec![chunk(0, 0, &[])];
        let plan = plan_build(&cs, &[0], false, MAX_VERTS, 0);
        assert!(plan.items.is_empty());
        assert!(planned_ranges(&cs, &plan, &[], &[], 0, 0, 0).is_empty());
    }
}
