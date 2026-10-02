// Pocket Voxel spec — THE single source of truth for the `voxel` surface.
//
// Same contract discipline as contracts/spec/spec.ts and mon-spec.ts:
// everything the Rust core (crates/pocketvoxel-core/), the
// cooker (voxelmon/cook/), the guest (voxelmon/game/) and the PSP
// EBOOT agree on is pinned HERE, in plain data.
// `contracts/spec/gen-voxel-rust.ts` deterministically generates
// `crates/pocketvoxel-core/src/spec.rs` from this file;
// `tests/voxel-contract.test.ts` regenerates it in-memory and byte-compares
// against the committed file, so TS and Rust can never drift.
//
// Conventions (inherited, non-negotiable):
//   - Little-endian everywhere.
//   - Colors are u32 ABGR (0xAABBGGRR) — the PSP GE COLOR_8888 layout.
//   - Op codes are append-only: never renumber, never reuse. 0 is reserved.
//
// See docs/VOXEL.md for the architecture this contract serves, including the
// content boundary (ROM-fed like upstream gen1recomp; nothing ROM-derived is
// ever committed).

// ---------------------------------------------------------------------------
// Geometry — coordinate units (upstream contract: docs/VOXEL.md §5)
// ---------------------------------------------------------------------------

/** Graphics unit: an 8x8 pixel tile — also one voxel footprint. */
export const TILE_PX = 8;
/** Walk-grid unit: a 16x16 pixel cell = 2x2 tiles. Every actor/warp coord. */
export const CELL_PX = 16;
/** Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles. */
export const BLOCK_PX = 32;
/** Tiles per block edge. */
export const BLOCK_TILES = 4;
/** Chunk edge in tiles — the mesh/cull/stream granularity. */
export const CHUNK_TILES = 16;
/** Chunk edge in world pixels (128). */
export const CHUNK_PX = CHUNK_TILES * TILE_PX;

/**
 * World space is world pixels, matching the upstream mod: +X east, +Y up,
 * +Z south, right-handed; a resting character faces +Z (south). Tile (tx,ty)
 * occupies x in [tx*8, tx*8+8), z in [ty*8, ty*8+8). Height is world px.
 */
export const WORLD_AXES = "y-up +z-south right-handed" as const;

/** The GB UI layer, in GB pixels and tiles. Composited over the diorama. */
export const GB_W = 160;
export const GB_H = 144;
export const UI_COLS = 20;
export const UI_ROWS = 18;

/**
 * Trainer-card art in the UI page (cook/atlas.ts buildUiPage packs it,
 * game/ui/trainercard.ts draws it). The UI page is 256 tiles addressed by GB
 * tile code, and the GB itself only ever fills 0x60..0xff — font_extra, the
 * font, and the battle HUD overlay. Everything below 0x60 is ours, except
 * tile 0, which the ui layer reserves as "cell empty".
 *
 * The card's art is not part of the GB's UI tile space at all: the original
 * bank-switches these sheets into VRAM while the card is up. Giving them
 * fixed codes down here is what lets the card be drawn with plain uiTile
 * calls instead of a new op and a new atlas page.
 */
/**
 * The UI atlas page's size, in tiles. 16 across, and 24 down rather than the
 * GB's 16: tile codes 0x00..0xff are the GB's own space (font, font_extra,
 * the battle HUD overlay) and everything this port adds has to live outside
 * it — below 0x60, which the GB leaves empty, and above 0xff.
 *
 * The extra rows are free. The page is prescaled x2 and gutter-packed, so
 * 16x16 tiles already lay out at 288x288 and pad to a 512x512 texture; 16x24
 * lays out at 288x432, which is still inside it.
 */
export const UI_PAGE_COLS = 16;
export const UI_PAGE_ROWS = 24;
export const UI_PAGE_TILES = UI_PAGE_COLS * UI_PAGE_ROWS;

export const UI_TILE = {
  /** 3x3 box pieces: 0 bottom, 1 right, 2 tl, 3 top, 4 tr, 5 left, 6 bl, 7 br, 8 fill. */
  frame: 0x01,
  /** The dot either side of the BADGES banner. */
  circle: 0x0a,
  /** Slot digits 1..8, one 8x8 tile each. */
  number: 0x0b,
  /**
   * A LEFT arrow, mirrored from the charmap's ▶ at cook time. The GB font has
   * ▶ ▷ ▼ and no ◀ — nothing in the original ever points left — and the Kanto
   * Gear's view switcher wants a matched pair either side of the view name.
   */
  arrowLeft: 0x13,
  /**
   * 8 gyms x 8 tiles: 4 face tiles (2x2), then 4 badge tiles (2x2). Gym `g`
   * starts at `badge + g * badgeStride`; the badge half is `+ badgeHalf`.
   */
  badge: 0x20,
  badgeStride: 8,
  badgeHalf: 4,
  /**
   * The six slot symbols, above the GB's own tile space: 2x2 tiles each, in
   * field.slotSymbols.order (7, BAR, CHERRY, FISH, BIRD, MOUSE), laid TL, TR,
   * BL, BR. Only the symbols come from the ROM's slot sheet — the machine's
   * frame is drawn from the GB's ordinary box tiles, which is 48 tile codes
   * this does not have to spend.
   */
  slotSymbol: 0x100,
  slotSymbolStride: 4,
} as const;

/** The PSP framebuffer the diorama renders at. */
export const VIEW_W = 480;
export const VIEW_H = 272;

/**
 * The world view in world pixels: the diorama frames 240x136 and renders 2x
 * into 480x272 (the Pocket Mon viewport choice — no integer scale fits
 * 160x144 on 480x272, so the view widens instead of blurring). Camera
 * distance = WORLD_VIEW_H, so rung 0 frames exactly these world pixels.
 */
export const WORLD_VIEW_W = 240;
export const WORLD_VIEW_H = 136;

/** Fixed simulation step: 60 Hz. The tick index is the only clock. */
export const TICK_HZ = 60;

// ---------------------------------------------------------------------------
// Input — one abstract button set for every host and every tape
// ---------------------------------------------------------------------------

export const VOX_BTN = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7,
} as const;

/** Facing / movement direction. Matches the walk-sheet frame order. */
export const DIR = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
} as const;

// ---------------------------------------------------------------------------
// Camera — the pitch ladder (upstream VoxelState, minus the FULL preset)
// ---------------------------------------------------------------------------

/**
 * Orbit pitch rungs in degrees measured from straight down: rung 0 frames
 * identically to the flat 2D game. The projection derives fov so a
 * straight-down camera at dist = vh frames exactly vh world pixels
 * (fov = 2*atan(1/(2*FOCAL)), FOCAL = 1).
 */
export const PITCH_RUNGS = [0, 15, 35, 50, 75] as const;
/** Camera tween between rungs, in ticks (0.25 s at 60 Hz), smoothstep. */
export const PITCH_TWEEN_TICKS = 15;
export const CAM_FOCAL = 1;

// ---------------------------------------------------------------------------
// The quality ladder — one cooked pak, many machines
// ---------------------------------------------------------------------------
//
// This runtime is ported to machines that differ by an order of magnitude in
// throughput, so fidelity is a LADDER a machine climbs, not a build flag. A
// host names the rung its hardware holds (`quality(tier)`) and the core reads
// that rung's dials out of `QUALITY` while it builds each frame.
//
// Every dial here is a RUNTIME dial: one cooked pak serves every rung, so the
// rung is a host decision and never a re-cook. Rungs are append-only exactly
// like op codes — a machine may be added, none may be renumbered — and the
// default rung is the WEAKEST one, so a host that never calls `quality` gets
// the cheapest frame rather than the dearest.
//
// **The top rung is the identity.** It draws what this runtime drew before
// the ladder existed, pixel for pixel; `tests/goldens/voxel/*-max.hashes` are
// the pre-ladder frame hashes, replayed at the top rung and asserted
// byte-for-byte, so no later rung edit can quietly move the picture the
// ladder is supposed to preserve. That is also why `chunkDist` holds
// `CHUNK_DRAW_DIST_PX` at every rung including the top: it is a pre-existing
// frame-budget cap being folded in from `draw.rs` (where it was the
// hard-coded `CULL_DIST`), not a new fidelity dial, and widening it at the
// top would draw MORE than the pre-ladder runtime rather than the same.
//
// Distances are world px, measured from the view centre to a chunk's own
// centre and widened by that chunk's half-extent. Every dial goes through the
// same arithmetic in `draw::within_dist`, so a dial added later cannot
// measure differently from the ones the goldens were recorded against.
//
// **A dial here is still a runtime dial when the GEOMETRY differs.** Tree LOD
// cooks BOTH levels of detail into every chunk — the carved hull in mesh kind
// `treeHull`, the same cells as plain boxes in `treeBox` — and the runtime
// picks one per chunk through `treeHullDist`. One pak still serves every rung.
// What the pak must then state is which levels it actually carries, and that
// is a META flag (`VXPK_META_FLAG_TREE_LOD`), not an entry in this table: a
// pak cooked without the box level renders every tree carved at every rung
// instead of misrendering, and a pak cooked with `VOXEL_TREE_BOXES=1` (the
// ladder's predecessor: a global cook switch) carries neither level and draws
// its boxes out of the terrain stream, as it always did.

/**
 * The rungs, weakest first. Append-only: never renumber, never reuse.
 * `QUALITY[tier]` is that rung's dials, so the array and this table are one
 * data structure in two halves (`tests/voxel-contract.test.ts` pins that).
 */
export const QUALITY_TIER = {
  /** PSP-class. Measured GE throughput ~1.1 M tri/s = ~18 k tris at 60 fps. */
  psp: 0,
  /** PS Vita-class: the same geometry with roughly four times the budget. */
  vita: 1,
  /** Desktop, and the identity rung: exactly the pre-ladder picture. */
  desktop: 2,
} as const;

/**
 * The rung a scene boots at, and the rung it returns to after `reset()` only
 * if the host never picked one. The weakest rung is the default on purpose:
 * an unported host renders a frame its machine can hold.
 */
export const QUALITY_TIER_DEFAULT = QUALITY_TIER.psp;

/**
 * "No limit" for a distance dial, in world px. A finite sentinel rather than
 * an infinity so the generated Rust stays a plain `f32` literal and the
 * widened compare (`(limit + half)^2`) can never produce a NaN; 1e9 px is six
 * orders of magnitude past the diagonal of the largest map this pipeline
 * cooks.
 */
export const QUALITY_UNBOUNDED = 1e9;

/**
 * "This level never draws" for a distance dial. Negative on purpose and
 * handled EXPLICITLY in `draw::within_dist` (a negative limit admits
 * nothing): the half-extent widening means any non-negative dial — even 0 —
 * still admits the chunk under the view centre, so "off" needs its own
 * value, not a small number.
 */
export const QUALITY_OFF = -1;

/**
 * The chunk distance cap: 2.5 view-heights, the mod's own north-reach cap for
 * its shadow frustum. The frustum's far plane is effectively infinite
 * (dist*4 + 4096), so without this a leaned camera admits every chunk up-map.
 * Held at every rung — see the identity note above.
 */
export const CHUNK_DRAW_DIST_PX = 2.5 * WORLD_VIEW_H;

/**
 * The dials, indexed by `QUALITY_TIER`. Adding a dial is appending a field to
 * every row; adding a machine is appending a row.
 *
 * `grassDist` / `flowerDist` fade the two ankle-height detail meshes: past a
 * few tiles a grass tuft is a texture, not a silhouette, and the cooker emits
 * two standing slabs per grass cell and a cutout per flower cell across the
 * whole field. On ROUTE_1 at pitch rung 2 those two meshes are 40 k of the
 * frame's 80 k triangles — half the frame spent below the ankle.
 *
 * `treeHullDist` / `treeCoarseDist` pick a chunk's tree geometry from THREE
 * cooked levels: inside `treeHullDist` the fine carve (`MESH_KIND.treeHull`,
 * 1x1-px voxels, ~700 quads a cell), between it and `treeCoarseDist` the
 * coarse carve (`MESH_KIND.treeCoarse`, 2x2-px voxels, ~1/4 the quads with
 * the SAME full-resolution art on the faces), past both the plain box
 * (`MESH_KIND.treeBox`, under ten). Trees are the largest single item on the
 * ladder — fine hulls are 53 k of PALLET_TOWN's 97 k triangles at pitch rung
 * 2 and 34 k of ROUTE_1's 80 k, more than grass, flowers and water together,
 * and ROUTE_1 is a corridor whose trees are all NEAR, which is why the psp
 * rung's near level is the coarse carve (`treeHullDist: 0`): no distance
 * dial reaches near trees, only a cheaper carve does.
 *
 * `pullDepthBias` (0/1) changes HOW the pulled meshes (grass, flower) get
 * their camera-ward depth trick, not how many draw. Geometric pull — the
 * mod's own — displaces every vertex toward the eye along its own ray, which
 * on the PSP means re-staging every pulled vertex on the CPU each frame:
 * **measured 65-73 ms of a 100 ms Route-1 seam frame at ~1.15 µs per vertex**
 * (2026-08-06 autopilot, docs/VOXEL.md §4a). With the dial on, those meshes
 * draw their cooked vertices IN PLACE and the pull becomes one constant
 * NDC-depth bias per mesh, folded into the projection matrix
 * (`draw::depth_bias`) — zero per-vertex work. The bias is computed to equal
 * the geometric pull's depth shift exactly AT THE CAMERA FOCUS, which is the
 * player's own cell under the orbit rig and the arena centre under a battle
 * rig — precisely where grass-over-feet layering is a gameplay contract.
 * Away from the focus plane the bias drifts from the geometric value
 * sub-pixel-ward; the top rung keeps the geometric path, so the anchor
 * stands.
 */
export const QUALITY = [
  // psp — retuned 2026-08-06 for the 30 fps present lock, under one rule the
  // 60 fps push had traded away: NO camera-relative representation change
  // inside the visible field. A distance dial whose boundary sits in view
  // moves with every step, and the swap it hides becomes a walking artifact
  // — the roadside light-tree ring twinkled coarse<->box at 96 px, the
  // ground flipped baked<->live at the live-bubble's edge one cell ahead of
  // the player, and grass popped in and out at its 96 px fade line (all
  // three device-reported the same afternoon). Every distance dial on this
  // rung is now either unbounded (ONE representation everywhere the frustum
  // reaches) or off; what remains of the 60 fps savings are the UNIFORM
  // dials — half density, coarse-only trees, bake-everywhere — which cannot
  // flicker because they never switch. The measurements that priced the
  // moving boundaries live on in docs/VOXEL.md §4a and §7.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    // Every carved tree this rung draws is the COARSE one (fine is OFF —
    // measured 2026-08-06 over the ring report: the underfoot fine ring
    // alone was 10 968 triangles on ROUTE_1 and 11 630 on PALLET_TOWN
    // against ~3 400 as coarse). Coarse is uniform across the field; the
    // box level never shows on this rung and remains the fallback for a
    // pak cooked without the coarse stream.
    treeHullDist: QUALITY_OFF,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 1,
    // OFF makes every eligible chunk draw the baked quad — including the
    // ground underfoot. The bake is exact at the rung-2 rest pitch by
    // construction and CHEAPER than the live terrain it replaces; the live
    // bubble the old 0 dial kept around the player protected near-field
    // relief, but its edge crossed a chunk seam one step ahead of the
    // player and the baked<->live swap read as the road jumping.
    groundBakeDist: QUALITY_OFF,
    // Draw every FOURTH grass/flower quad (the cook packs each chunk's
    // detail quads in bit-reversed order, so any prefix of the index range
    // is a stratified — spatially uniform — sample of the field). Unlike a
    // fade distance this is uniform: no boundary, nothing to pop. It is
    // also what pays for the unbounded dials above: within the route-1
    // chunk reach the raw detail streams are 52k+20k triangles, the
    // largest slices of the frame; 4 (with the coarse carve's rear
    // hemisphere dropped at cook) holds the measured worst outdoor
    // segments at the 33.3 ms present slot that 2 and 3 missed.
    detailDensity: 4,
  },
  // vita — a placeholder, not a measurement. It was 192 px dials that were
  // measured pixel-identical to the top rung on the v1 maps; under the
  // no-moving-boundary rule above the honest spelling of "identical" is the
  // top rung's own dials, so a bigger map cannot quietly re-introduce a
  // boundary that today's tapes never crossed.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    treeHullDist: QUALITY_UNBOUNDED,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 0,
    groundBakeDist: QUALITY_UNBOUNDED,
    detailDensity: 1,
  },
  // desktop — the identity rung: every mesh unbounded, as before the ladder.
  {
    grassDist: QUALITY_UNBOUNDED,
    flowerDist: QUALITY_UNBOUNDED,
    treeHullDist: QUALITY_UNBOUNDED,
    treeCoarseDist: QUALITY_UNBOUNDED,
    chunkDist: CHUNK_DRAW_DIST_PX,
    pullDepthBias: 0,
    groundBakeDist: QUALITY_UNBOUNDED,
    detailDensity: 1,
  },
] as const;

// ---------------------------------------------------------------------------
// Diorama constants — baked at cook time, pinned here so cooker and any
// future on-device mesher can never disagree (upstream Voxel3D/ChunkMesher)
// ---------------------------------------------------------------------------

/** Per-face shade multipliers, sun in the southeast. Index = face id. */
export const FACE_SHADE = {
  east: 0.84, // +X
  west: 0.72, // -X
  up: 1.0, // +Y
  down: 0.55, // -Y
  south: 0.9, // +Z (the drawing itself, full brightness on volume runs)
  north: 0.68, // -Z
} as const;
export const VOLUME_TOP_SHADE = 0.85;
export const GABLE_TOP_SHADE = 0.95;

/** Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded). */
export const AO = {
  step: 0.216, // per crowding neighbour on a top corner, max 3
  edge: 0.664, // crease multiplier on a side face
  corner: 0.441, // inside-corner multiplier (edge^2, floored)
  ground: 0.288, // prop ground-contact term
  risePx: 6, // px over which the ground term releases
  floor: 0.25, // shade never drops below this
} as const;

/** Water surface sits below ground; the -2 px lip is the shoreline. */
export const WATER_DROP_PX = 2;
/** Grass tuft slabs: thickness and per-cell placement (two rows per cell). */
export const GRASS_THICK_PX = 2;

/**
 * Tile-class fallback heights in world px (upstream voxel_heights defaults).
 * Profile pins from the reference checkout override per tileset at cook time.
 */
export const CLASS_HEIGHT = {
  ground: 0,
  water: -2,
  void: 0,
  ledge: 6,
  fence: 10,
  sign: 12,
  wall: 16,
  cliff: 32,
  tree: 16,
  roof: 28,
  counter: 8,
  table: 12,
  desk: 24,
  prop: 16,
  cylinder: 16,
  canopy: 32,
  stump: 16,
  grass: 0,
  flower: 0,
} as const;

/** Volume measurement caps (upstream Structures MAX_ROWS). */
export const VOLUME_MAX_ROWS = 6;

/**
 * Billboard camera-ward pull, world px: pull(a) = PULL_BASE +
 * max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN).
 * Applied along each vertex's own eye ray — a pure depth bias.
 */
export const PULL_BASE = 6;
export const PULL_NUM = 16;
export const PULL_SUB = 8;
export const PULL_MIN_SIN = 0.2;
/** Flowers give up one tile row of depth advantage vs the cards. */
export const FLOWER_PULL_SUB_PX = 8;

/** Ghost silhouette: flat color + alpha, drawn with inverted depth test. */
export const GHOST_ABGR = 0x80484242;

// ---------------------------------------------------------------------------
// Battle staging (upstream BattleArena/BattleCam, solved constants)
// ---------------------------------------------------------------------------

/** Arena footprints in cells; mons stand 3 cells = 48 px apart. */
export const ARENA_SHAPE = {
  /** 3x6 cells, enemy at (1,1), player at (1,4), 1-cell apron. */
  wide: 0,
  /** 1x4 cells, enemy at (0,0), player at (0,3). */
  narrow: 1,
} as const;
export const ARENA_GAP_CELLS = 3;
/** Clearance walk: sample step and the three sight lines per mon (px). */
export const CLEAR_STEP_PX = 4;
export const CLEAR_LINES_Y = [1, 8, 16] as const;
export const CLEAR_EPS = 1.5;
/** Off-map ground height during clearance — the border ring is trees. */
export const CLEAR_OFFMAP_H = 32;

/** The two solved over-the-shoulder rigs (offsets in world px). */
export const RIG = {
  tele: {
    side: 78.79,
    back: 144.96,
    height: 37.88,
    lookX: -0.26,
    lookY: 0.34,
    frameH: 34.11,
  },
  wide: {
    side: 41.98,
    back: 41.16,
    height: 28.48,
    lookX: -3.24,
    lookY: -1.35,
    frameH: 55.62,
  },
} as const;
/** Idle drift: yaw ±2° over 26 s, dolly ±2% over 37 s (in ticks). */
export const RIG_PAN_YAW_DEG = 2;
export const RIG_PAN_TICKS = 1560;
export const RIG_DOLLY = 0.02;
export const RIG_DOLLY_TICKS = 2220;
/** Player steering clamps. */
export const RIG_PITCH_MAX_DEG = 45;
export const RIG_ZOOM_MIN = 0.45;
export const RIG_ZOOM_MAX = 2.0;
/** Battle shadow decals darken harder than free-roam (cards need grounding). */
export const SHADOW_ALPHA_FIELD = 0.4;
export const SHADOW_ALPHA_BATTLE = 0.68;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Max simultaneously shown entity billboards (player is slot 0). */
export const ENTS_MAX = 16;

export const ENT_FLAG = {
  /** Mirror the card on X (right-facing / alternating walk step). */
  mirror: 1 << 0,
  /** Draw the ghost silhouette pass for this entity (the player). */
  ghost: 1 << 1,
  /** Card is a 16x16 grass-occluded walker (draw before grass mesh). */
  walker: 1 << 2,
} as const;

/** Emote bubble kinds (upstream field.emotionBubbles order for Red). */
export const EMOTE = {
  none: 0,
  shock: 1,
  question: 2,
  happy: 3,
} as const;

// ---------------------------------------------------------------------------
// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.
// ---------------------------------------------------------------------------
//
// All args are i32 unless noted. String args exist only where marked (the
// QuickJS host passes them as interned C strings; ops stay synchronous).
//
//   system
//     gamedata() -> ArrayBuffer            the pak GAME section (boot, cold)
//     stats() -> ArrayBuffer               frame counters (debug)
//     reset()                              drop scene state to boot
//     audiodata() -> ArrayBuffer | null    the pak AUDIO section (boot, cold):
//                                          the chip synth's program banks +
//                                          their manifest. Null where the pak
//                                          carries no audio — the guest then
//                                          runs silent. Same one-cold-read
//                                          discipline as gamedata()
//     quality(tier)                        climb the quality ladder to
//                                          QUALITY_TIER `tier`: the core
//                                          applies that rung's QUALITY dials
//                                          while it builds every later frame
//                                          (grass and flower draw distances,
//                                          the chunk distance cap). HOST
//                                          configuration, not guest state —
//                                          the host knows the machine, the
//                                          guest does not, and one cooked pak
//                                          serves every rung, so no op stream
//                                          and no pak byte differs between
//                                          tiers. `reset()` KEEPS the rung,
//                                          exactly as it keeps the synth's
//                                          rate. An out-of-range tier is a
//                                          no-op, so a host naming a rung
//                                          this core does not carry keeps the
//                                          rung it had instead of guessing.
//                                          Boots at QUALITY_TIER_DEFAULT
//   world
//     mapShow(slot, mapId, ox, oy)         slot 0 current, 1..4 neighbours;
//                                          ox/oy = seam offset in world px
//     mapHide(slot)
//     cam(x, y)                            view centre, world px (Q4 fixed:
//                                          value = px*16, so scroll is smooth)
//     pitch(rung)                          PITCH_RUNGS index; tweens
//     tint(abgr)                           global day tint (CLUT rewrite)
//     stamp(mapId, cx, cy, on)             toggle a removable stamp
//     palette(index)                       selects the SGB palette for the
//                                          terrain/sprites/pics CLUTs: index
//                                          into the pak's SGB set (sampled
//                                          from VPAL[4 + index]); -1 restores
//                                          the GB grayscale ramp; ui always
//                                          keeps the raw ramp. A pak carrying
//                                          per-tile RED++ color (VXPK_TAG
//                                          .color) overrides this per map and
//                                          per page — see that tag's
//                                          precedence rule. Color is a pak
//                                          capability, not a guest concern:
//                                          the wire is unchanged either way
//   entities
//     ent(slot, sheet, frame, x, y, lift, flags)   x/y world px Q4; lift px
//     entHide(slot)
//     emote(slot, kind)                    EMOTE; kind 0 clears
//   ui (the GB tile layer; tile ids index the cooked UI atlas)
//     uiTile(x, y, tile)
//     uiFill(x, y, w, h, tile)
//     uiText(x, y, str)                    STRING arg; charmap-resolved.
//                                          THE one live typewriter run: the
//                                          core retains only the last, gated
//                                          by uiReveal — static labels go
//                                          into the grid via uiTile instead
//     uiReveal(n)                          glyphs of the last uiText shown
//     uiClear()
//   battle
//     arena(mapId, x, y, shape, rig)       stage at cell (x,y); ARENA_SHAPE,
//                                          rig = 0 tele, 1 wide
//     card(side, pic, x, y[, dx, dy, dz]) side 0 player, 1 enemy; pic =
//                                          atlas page; cell coords, plus an
//                                          optional Q4-px offset from the
//                                          cell centre for the battle
//                                          animations (omitted = still).
//                                          dy lifts; negative sinks.
//     cardHide(side)
//     battleCam(orbit, pitch, zoom[, lift, dist])
//                                          Q8 fixed 0..256 = 0..1 (zoom Q8 x);
//                                          dist (Q8 multiplier on the rig's eye
//                                          distance; 0 or omitted = as solved)
//                                          stands the camera further off -- the
//                                          3DS host draws at its own fixed fov,
//                                          so zoom alone does not widen the shot;
//                                          lift (Q8 of the framed height, 0 when
//                                          omitted) aims the rig that much below
//                                          the arena midpoint, so the mons sit
//                                          higher on screen -- Gold keeps a
//                                          full-width text box over the bottom
//                                          third
//     arenaEnd()
//   audio (the chip synth; the core interprets the ROM's channel programs and
//         renders PCM — the guest states WHAT to play, never a sample)
//     Every arg is a number the GUEST resolved out of the AUDI manifest: the
//     core parses no JSON and knows no names. `bank` is always a BANK SLOT —
//     the index of a 0x4000-byte window inside the AUDI programs half, i.e.
//     the position of that ROM bank in the manifest's `bankOrder`. `addr` is
//     the program's GB address inside that window (0x4000..0x7fff), and
//     `engine` is the sound-engine id whose wave/drum tables the program
//     uses (1..3 in Red). AUDIO_ENGINE_GEN2 (4) is Gold's driver: that id
//     also selects the Gen 2 interpreter, and a cry's `length` is then its
//     tempo word itself (no $80 base).
//     music(bank, addr, engine, flags)     start a song; flags = MUSIC_FLAG
//                                          (loop = the reference's
//                                          allowLoops, ChipSynth.lua:429).
//                                          Replaces whatever was playing:
//                                          "the same song does not restart"
//                                          is guest policy (Music.lua:239)
//     musicStop()                          drop the song, keep the stream
//     musicFade(ticks)                     Music.lua:312 fadeOut: rAUDVOL
//                                          steps AUDIO_FADE_LEVELS -> 0, one
//                                          level every `ticks` ticks, and the
//                                          song stops at 0. ticks <= 0 stops
//                                          immediately
//     sfx(bank, addr, engine, pitch, tempo, flags)
//                                          a one-shot over the music
//                                          (ChipAudio.lua:414 newSfx): pitch
//                                          = wFrequencyModifier added to
//                                          every tone register, tempo = the
//                                          SFX frame length (the reference
//                                          passes 0 and AUDIO_SFX_TEMPO for
//                                          the plain form). flags = SFX_FLAG;
//                                          `duck` is the FANFARE rule
//                                          (Sound.lua:55, Music.lua:102) —
//                                          the song PAUSES for the jingle and
//                                          resumes after it, which is what
//                                          stealing the music's channels
//                                          sounds like
//     cry(bank, addr, engine, pitch, length)
//                                          the species cry (ChipAudio.lua:425
//                                          newCry): pitch = the cry table's
//                                          frequency modifier, length = its
//                                          tempo byte, which becomes every
//                                          non-noise channel's frame length
//     audioWaves(engine, bank, addr)       pin a sound engine's 6-entry wave
//                                          instrument table (manifest
//                                          waveBanks[engine], ChipSynth.lua
//                                          :685). Boot-time, once per engine
//     audioDrum(engine, drum, bank, addr)  pin one drum program of a sound
//                                          engine (manifest
//                                          noiseHeaders[engine][drum],
//                                          ChipSynth.lua:645). Boot-time; a
//                                          music noise note names a drum by
//                                          this id
//     pikaPcm(clip)                        Yellow: one of the ROM's voiced
//                                          Pikachu clips, 1-based
//                                          (PikachuCriesPointerTable order,
//                                          audio/pikachu_pcm.asm
//                                          PlayPikachuSoundClip). The host
//                                          hands the core the clips at boot
//                                          (the Yellow overlay's PIKA chunk);
//                                          without them this is a no-op. The
//                                          song and any effect HOLD while it
//                                          plays -- the Game Boy plays it
//                                          with interrupts off
//
// Audio PCM leaves through the PocketJS audio module (contracts/spec/audio.ts,
// capability `audio.pcm`), not through this surface: the host pumps
// `Scene::render_audio` for exactly the frames its ring wants. A host that
// mounts no audio module never calls it and the identical op stream runs
// silent.

export const VOX_OP = {
  gamedata: 1,
  stats: 2,
  reset: 3,
  quality: 4,
  audiodata: 17,

  mapShow: 10,
  mapHide: 11,
  cam: 12,
  pitch: 13,
  tint: 14,
  stamp: 15,
  palette: 16,

  ent: 30,
  entHide: 31,
  emote: 32,
  pic: 33,
  picHide: 34,
  picDepth: 35,

  uiTile: 50,
  uiFill: 51,
  uiText: 52,
  uiReveal: 53,
  uiClear: 54,

  arena: 70,
  card: 71,
  cardHide: 72,
  battleCam: 73,
  arenaEnd: 74,

  music: 18,
  musicStop: 19,
  musicFade: 20,
  sfx: 21,
  cry: 22,
  audioWaves: 23,
  audioDrum: 24,
  // Kanto Gear companion (bottom screen) UI surface. Append-only: 75-78.
  uiTileBottom: 75,
  uiFillBottom: 76,
  uiClearBottom: 77,
  uiSpriteBottom: 78,
  /**
   * A field effect: one emote-page frame drawn as a billboard at a world
   * position, for as long as the guest leaves it up. Args are x, z in Q4
   * world px and the frame index; frame < 0 clears it.
   *
   * The overworld had no way to draw a sprite anywhere but on an entity, so
   * HM Cut's tree animation (pokered AnimateCutTree, which flickers the
   * cut-tree sprite over the tree before the block changes) had nowhere to
   * live. The guest owns the flicker timing; this op only says what is on
   * screen right now.
   */
  fieldFx: 79,
  /**
   * One 8x8 move-animation tile for this frame, in GAME BOY pixels (the
   * guest converts OAM space: x - 8, y - 16). Append-only like the bottom
   * sprites: the guest re-emits every sprite each frame and `animClear`
   * resets the count.
   *   args: page, tile, x, y, flags (bit 0 x-flip, bit 1 y-flip)
   */
  animSprite: 80,
  /** Drop every move-animation sprite (start of frame, end of animation). */
  animClear: 81,
  /**
   * Declare a rectangle of the UI grid as a HUD PANEL belonging to one side
   * of a battle: the name/level/HP box the GB draws in fixed cells.
   *
   * The sprites it used to sit on top of are 3D cards now, and they move
   * with the camera, so the core slides the whole rect sideways to keep it
   * beside its own mon (core ui.rs panel_shift). The guest keeps drawing
   * the tiles where the GB puts them and says which cells are the panel.
   *   args: side (0 player, 1 enemy), x, y, w, h -- cells; w = 0 clears it
   */
  uiPanel: 82,
  /**
   * How fast the C-stick swings the camera, as a Q8 multiplier of the
   * host's own rates (256 = the rates as tuned). The OPTION screen's
   * CAMERA SPEED row; the guest states it every frame, the host reads it
   * off the scene when it turns the stick into degrees.
   */
  camSpeed: 83,
  /**
   * Kanto Gear: part of an atlas page on the bottom screen -- one frame of a
   * sprite sheet (a trainer, the item ball) or a UI tile blown up as an icon.
   * Shares uiSpriteBottom's per-frame list and draw order (over the grid).
   *   args: page, x, y, w, h (bottom-screen px), src = sx | sy << 16,
   *         size = sw | sh << 16 (page px), flags (bit 0 = mirror x)
   */
  uiSpriteRectBottom: 84,
  /**
   * Kanto Gear: a flat rectangle on the bottom screen, under the tile grid
   * -- the area map's cells and the notes pad's ink.
   *   args: x, y, w, h (bottom-screen px), shade (0 light .. 3 darkest)
   * Cleared by uiClearBottom with everything else.
   */
  uiRectBottom: 85,
  /** Yellow's voiced Pikachu clip `clip` (1-based) -- see §audio above. */
  pikaPcm: 86,
  /**
   * The GB screen (crates/pocketvoxel-core gb.rs; voxelmon/game/gb/video.ts):
   * a Game Boy's tile maps, registers, per-line overrides and OAM, drawn the
   * way the hardware draws them, over the pictures -- for the screens ported
   * straight off the hardware (Yellow's Surfing Pikachu). 90 is skipped: the
   * 3DS host's viewer hook claims it.
   *   gbShow(on)                               draw it this frame on
   *   gbTiles(dest, page, first, count[, wide, stride, map])
   *                                            VRAM tiles dest.. hold `count`
   *                                            tiles of atlas page `page`
   *                                            from `first` (0..127 $8000,
   *                                            128..255 $8800, 256.. $9000);
   *                                            with `wide`, taken `wide` a
   *                                            row out of rows `stride` long;
   *                                            page -2: map `map`'s terrain
   *   gbReset()                                maps, OAM, loads, registers
   *   gbMap(offset, hex)                       map bytes from `offset`
   *                                            ($9800 = 0, $9C00 = 0x400)
   *   gbRegs(lcdc, scx, scy, wx, wy, bgp, obp0, obp1)
   *   gbLines(target, hex)                     wLYOverrides: 144 bytes for
   *                                            0 none, 1 SCY, 2 SCX
   *   gbOam(hex)                               160 bytes of OAM
   *   gbColours(bg, obp0, obp1)                SGB palette indices (the
   *                                            `palette` op's), -1 grey
   */
  gbShow: 87,
  gbTiles: 88,
  gbReset: 89,
  gbMap: 91,
  gbRegs: 92,
  gbLines: 93,
  gbOam: 94,
  gbColours: 95,
  /**
   * The Gold screen (crates/pocketvoxel-core lcd.rs;
   * voxelmon/game/gen2/platform/lcd.ts): a Game Boy Color's maps, objects
   * and palettes without its budgets, over the 3D world. Tile ids are
   * 16-bit and name cooked atlas tiles through banks; a cell whose
   * attribute has bit 4 (hole) set lets the world show through.
   *   lcdShow(on)
   *   lcdBank(base, page, count)       tile ids base.. are page's tiles 0..
   *   lcdReset()                       maps, objects, palettes, registers
   *                                    (the banks stay)
   *   lcdCells(offset, hex)            cells from `offset` (window = 1024),
   *                                    six digits each: tile(4) attr(2)
   *   lcdRegs(scx, scy, wx, wy, flags) flags: 1 bg, 2 window, 4 objects,
   *                                    8 tall (8x16) objects
   *   lcdObjs(hex)                     the whole object list, fourteen
   *                                    digits each: y(4) x(4) signed screen
   *                                    px, tile(4), attr(2)
   *   lcdPals(first, hex)              RGB555 colours (4 digits) from
   *                                    `first`: slot*4+colour, slots 0-15
   *                                    background, 16-31 objects
   *   lcdLines(target, hex)            144 per-line bytes: 0 none, 1 SCY,
   *                                    2 SCX
   */
  lcdShow: 96,
  lcdBank: 97,
  lcdReset: 98,
  lcdCells: 99,
  lcdRegs: 100,
  lcdObjs: 101,
  lcdPals: 102,
  lcdLines: 103,
  /**
   * Gold's time of day for the world's colours: 0 MORN, 1 DAY, 2 NITE,
   * 3 DARK (an unlit cave). A pak whose VCOL has VXPK_COLOR_FLAG_DAYTIME
   * cooks four palettes per map and per sprite sheet, and this picks the
   * one drawn; other paks ignore it.
   *   daytime(k)
   */
  daytime: 104,
  /**
   * The OPTION screen's TILT SHIFT: 0 off, 1 soft, 2 strong. The host blurs
   * the top and bottom of the 3D world (never the UI over it) and leaves a
   * sharp band across the middle. Stated every frame.
   *   tiltShift(level)
   */
  tiltShift: 105,
  /**
   * Which Gold screen the lcd* ops (96-103) that follow address: 0 the top
   * (over the world), 1 the bottom screen (Gold's companion panel; the host
   * shows its top 160x120 at 2x, filling the 320x240 screen). Each screen
   * keeps its own cells, banks and palettes.
   *   lcdTarget(k)
   */
  lcdTarget: 106,
  /**
   * A battle card's own four colours, lightest first, as RGB555 (Gold: the
   * species' battle palette, shiny or not -- its pic pages carry no VCOL
   * palette of their own). The card's page is drawn through them while that
   * side is staged; c0 < 0 drops them. Survives `card`, cleared by
   * `arenaEnd`.
   *   cardPal(side, c0, c1, c2, c3)
   */
  cardPal: 107,
  /**
   * The Gold screen's UNDER layer (VIEW 2D): a whole map's cells, uploaded
   * once, that the background's holes show at a camera position instead of
   * the world -- so walking sends a position, not the screen's cells. Same
   * six-digit cells as lcdCells. Cleared by lcdReset.
   *   lcdUnder(w, h)                   size it, all hole (0 drops it)
   *   lcdUnderRow(row, hex)            cells of row `row` from column 0
   *   lcdUnderAt(on, x, y)             show it this frame, its pixel (x, y)
   *                                    at the screen's top-left
   */
  lcdUnder: 108,
  lcdUnderRow: 109,
  lcdUnderAt: 110,
  /**
   * The 3D world cannot be seen (the OPTION screen's VIEW 2D, outside a
   * 3D battle): the host still loads each map's pak -- the 2D screens read
   * its pages -- but builds no mesh, seam strips or trees for it, and
   * builds them when this goes back to 0. Stated every frame.
   *   flatWorld(on)
   */
  flatWorld: 111,
  /**
   * The under layer's tile aliases (Gold VIEW 2D's water and flowers): the
   * under layer's tile `from` draws as tile `to`, so an animation step is
   * one op, not a re-upload of every water cell. Sixteen slots; from < 0
   * empties the slot. Cleared by lcdReset.
   *   lcdAlias(slot, from, to)
   */
  lcdAlias: 112,
  /**
   * The under layer as a canvas of its own (Gold VIEW 2D's 2D SCREEN WIDE and
   * 2D ZOOM): `w` x `h` pixels (at most 512 x 256) with the screen's own
   * 160x144 centred in it, drawn behind the screen -- its holes then show
   * the canvas, not the layer. `wide`: the canvas fills the top screen's
   * width rather than the Gold screen's box. 0 x 0: off. Cleared by
   * lcdReset. The canvas's people go by lcdUnderObjsBin (the typed-array
   * op, packed as lcdObjsBin), at the 160x144's coordinates.
   *   lcdUnderView(w, h, wide)
   */
  lcdUnderView: 113,
  /**
   * The GB screen's wide picture (the Kanto games' 2D SCREEN WIDE / 2D ZOOM):
   * a `w` x `h` picture (at most 512 x 256) of the wide BG ring -- 64x32
   * tiles, sent by gbMap from offset 0x800 -- from its pixel (scx, scy),
   * in place of the hardware's 160x144. `full`: laid over the whole top
   * screen, else the Game Boy's rect. 0 x 0: off. Cleared by gbReset.
   *   gbWide(w, h, scx, scy, full)
   * Its objects, in the picture's own pixels, a lower index on top, OAM's
   * attribute bits; twelve digits each (y, x 16-bit two's complement,
   * tile, attr), 96 at most:
   *   gbWideObjs(hex)
   */
  gbWide: 115,
  gbWideObjs: 116,
  /**
   * A Gold screen shown whole (the 3DS bottom screen, which otherwise shows
   * its top 160x120 at 2x): all 160x144 at the top screen's scale, centred.
   * Gold's battle screens -- the party, the pack, the forget list -- drawn
   * on the bottom screen while a battle is staged in 3D above. Addressed by
   * lcdTarget like the other lcd ops; cleared by lcdReset.
   *   lcdTall(on)
   */
  lcdTall: 117,
} as const;

/** Clips in Yellow's PikachuCriesPointerTable (NUM_PIKA_CRIES). */
export const PIKA_PCM_CLIPS = 42;
/** Their sample rate: one bit per ~190 CPU cycles (RomExtractor.lua:2151). */
export const PIKA_PCM_RATE = 22050;

/** Emote-page frame of the HM Cut tree sprite (after the 3 GB bubbles). */
export const FX_FRAME_CUT_TREE = 3;

/**
 * Move-animation sprites on screen at once. A frame block is at most a
 * dozen tiles, but the emitters are wider: the water droplets lay rows
 * across the field and the petals fall twenty at a time.
 */
export const ANIM_SPRITES_MAX = 64;

/**
 * Screen-space pictures on the pic layer at once (`pic`). Six was one per
 * party member; the boot intro needs fifteen at the moment the fist comes
 * through -- the dark behind the paper, the lit field, the two fighters,
 * eight pieces of torn paper, the letterbox and the fist.
 */
export const PICS_MAX = 16;

/** Battle HUD panels the core may slide: one per side (`uiPanel`). */
export const UI_PANELS = 2;

/** Fixed-point scales used by op args. */
export const Q4 = 16;
export const Q8 = 256;

// ---------------------------------------------------------------------------
// The chip synth — constants the core, the cooker and the guest share
// ---------------------------------------------------------------------------
//
// The synth is a port of gen1recomp `src/core/ChipSynth.lua`; these are that
// file's own constants, pinned here so the Rust core and any TypeScript that
// resolves the manifest agree on them exactly.

/** One ROM sound bank: the window a program address is read inside. */
export const AUDIO_BANK_SIZE = 0x4000;
/** Sound-engine table slots. Red uses ids 1..3; slot 0 is never pinned;
 *  AUDIO_ENGINE_GEN2 is Gold's driver. */
export const AUDIO_ENGINES = 5;
/**
 * Gold's sound driver (pokegold audio/engine.asm), ported from gen1recomp
 * bdfac727 ChipSynth.lua's `generation == 2` paths. The engine id picks the
 * INTERPRETER as well as the tables: a program started on this id runs the
 * Gen 2 command set ($d0-$ff: octave, note_type, transpose, tempo, stereo
 * panning, drum kits, sound_call $fe / sound_loop $fd ...). Its tables are
 * pinned as `audioWaves(AUDIO_ENGINE_GEN2, bank, WaveSamples)` (the ten
 * 16-byte instruments) and `audioDrum(AUDIO_ENGINE_GEN2, 0, bank, Drumkits)`
 * (the kit pointer table; drum 0 is the whole table, not one drum).
 */
export const AUDIO_ENGINE_GEN2 = 4;
/** Gen 2 WaveSamples: ten instruments, 0-9 (ChipSynth.lua@bdfac727:1214). */
export const AUDIO_GEN2_WAVES = 10;
/** Gen 2 Drumkits: six kits (pokegold audio/drumkits.asm), 12 drums each. */
export const AUDIO_GEN2_DRUMKITS = 6;
/** Longest Gen 2 one-shot (ChipSynth.lua@bdfac727:1444 `maxSeconds or 12`). */
export const AUDIO_GEN2_EFFECT_MAX_SECONDS = 12;
/** Drum ids per sound engine (Red's tables reach 19). */
export const AUDIO_DRUMS = 32;
/** Wave instruments a sound engine exposes: 5 read + 1 shared across 6..9
 *  (ChipSynth.lua:685-707 — the ROM's table is short and the driver clamps). */
export const AUDIO_WAVES = 9;
/** The channel-program tick clock durations are counted in (ChipSynth.lua:18). */
export const AUDIO_TICKS_PER_SECOND = 15360;
/** One frame of the GB sound driver, in program ticks (ChipSynth.lua:19). */
export const AUDIO_FRAME_TICKS = 256;
/** The GB master clock the noise LFSR divides down (ChipSynth.lua:20). */
export const AUDIO_GB_CLOCK = 4194304;
/** The plain SFX tempo byte (ChipAudio.lua:418 `0x80 + (tempo or 0x80)`). */
export const AUDIO_SFX_TEMPO = 0x80;
/** rAUDVOL levels a fade walks down through (Music.lua:312 fadeOut). */
export const AUDIO_FADE_LEVELS = 7;
/** Longest one-shot the reference renders (ChipSynth.lua:849). */
export const AUDIO_EFFECT_MAX_SECONDS = 5;
/**
 * The synth's integer mix unit: one channel at full scale is AUDIO_MIX_UNIT.
 * 480 = lcm(15, 32), so both a pulse at volume v (v/15) and a wave nibble at
 * output level 1/4 ((n-8)/8 * 1/4) land on an integer — which is what lets
 * the whole mix run without a float and still quantize to the same s16 the
 * reference's doubles do.
 */
export const AUDIO_MIX_UNIT = 480;

/** `music(…, flags)`. */
export const AUDIO_MUSIC_FLAG = {
  /** Honor `sound_loop 0` instead of ending the channel (ChipSynth.lua:429). */
  loop: 1 << 0,
  /**
   * Gen 2 SOUND option STEREO (ChipSynth.lua@bdfac727:40-46 stereoEnabled):
   * the song's stereo_panning ($ef) bytes are honoured. Off = MONO, where
   * only force_stereo_panning ($e4) pans.
   */
  stereo: 1 << 1,
  /**
   * Keep going if this same program (bank, addr, engine) is already the
   * song: no restart, a running fade is cancelled back to full level
   * (Music.lua:242-250, the same-song cue during a pending fade), and the
   * `stereo` bit is re-applied live (ChipSynth.lua@bdfac727:1402
   * applyStereo). Any other song starts as usual.
   */
  resume: 1 << 2,
} as const;

/** `sfx(…, flags)`. */
export const AUDIO_SFX_FLAG = {
  /** A FANFARE: pause the song for the jingle (Sound.lua:55, Music.lua:102). */
  duck: 1 << 0,
  /** Cut the running one-shot (a Source:stop, Sound.lua@bdfac727:436);
   *  bank, addr, engine, pitch and tempo are ignored. */
  stop: 1 << 1,
  /** The low-health siren (ChipAudio.lua@bdfac727:667 newLowHealthAlarm),
   *  looping over everything until an sfx op with `alarm | stop`. The other
   *  arguments are ignored. */
  alarm: 1 << 2,
} as const;

// ---------------------------------------------------------------------------
// Events — core -> guest facts, drained as one batch per tick. APPEND ONLY.
// ---------------------------------------------------------------------------
//
// Wire layout: a u32 count, then `count` records of EVENT_SIZE bytes:
//   u16 kind | u16 a | i32 b | i32 c | i32 d
// No kinds are defined yet: the core currently states no fact the guest does
// not already know. The channel is pinned so streaming/timing facts can
// append later without a wire change.

export const VOX_EVENT = {} as const;

export const EVENT_SIZE = 16;
export const EVENT_CAP = 64;

// ---------------------------------------------------------------------------
// VXPK — the cooked content container
// ---------------------------------------------------------------------------
//
// Layout (MONPAK discipline):
//   0   u32  MAGIC ('VXPK' LE)
//   4   u16  VERSION
//   6   u16  section count
//   8   u32  total byte length
//   12  u32  reserved (0)
//   16  section table: `count` entries of VXPK_ENTRY_SIZE bytes:
//              u32 tag | u32 offset | u32 length | u32 count
//   ..  section payloads, each aligned to VXPK_ALIGN
//
// Every offset is from the start of the blob. Sections appear in tag order.
// The core is the only untrusted-byte reader: it validates every range and
// never indexes unchecked.

export const VXPK_MAGIC = 0x4b505856; // 'VXPK'
/**
 * 4 grew the chunk record by the two tree levels of detail and META by a
 * flags word; 5 grew the record again by the MIDDLE tree level
 * (`MESH_KIND.treeCoarse`); 6 by the baked-ground quad
 * (`MESH_KIND.groundBake`) and its per-chunk bake page; 7 by the baked
 * chunk's kept-structure stream (`MESH_KIND.terrainKeep`); 8 shrank the
 * vertex to 16 bytes (u16 fixed-point UVs). The shapes are
 * pinned below and both readers validate them, so an older pak is
 * rejected, never mis-read.
 */
export const VXPK_VERSION = 8;
/**
 * The version a pak carrying TINS declares. A v8 pak has the nine sections
 * below and nothing else; a v9 pak adds TINS as a tenth (it sorts last, so
 * nothing before it moves). Readers take both, so only the maps that need
 * instancing are recooked.
 */
export const VXPK_VERSION_TREES = 9;
/**
  * How far a tree instance draws its carved NEAR shape, world px.
  *
  * A carved hull is ~2,900 vertices and a coarse carve ~800, against a
  * console that draws a couple of hundred thousand a frame: detail has to
  * be spent on what is close enough to see it. Past TREE_MID_PX an instance
  * draws its box, which is under a hundred vertices and still a tree.
  */
export const TREE_NEAR_PX = 96;
/** Past this an instance draws its box (see TREE_NEAR_PX). */
export const TREE_MID_PX = 224;
/** Bytes per TINS instance record: i16 x,y,z | u16 near | u16 far | u16 pad. */
export const VXPK_TREE_INST_SIZE = 12;
/** Bytes per TINS shape record: a mesh range (12) padded to 16. */
export const VXPK_TREE_SHAPE_SIZE = 16;
/** "this instance has no shape at that level of detail". */
export const TREE_SHAPE_NONE = 0xffff;
export const VXPK_HEADER_SIZE = 16;
export const VXPK_ENTRY_SIZE = 16;
export const VXPK_ALIGN = 16;
/** The META record: eight u32 counts/dims, then a flags word and a pad word. */
export const VXPK_META_SIZE = 40;
/**
 * META flag bit 0: every chunk carries BOTH tree levels of detail — the
 * carved hulls in `MESH_KIND.treeHull` and the same cells as plain boxes in
 * `MESH_KIND.treeBox` — so a runtime may pick one per chunk (`treeHullDist`).
 * A pak WITHOUT this flag carries at most one level, and a runtime that wants
 * the other draws whichever the pak holds instead of dropping the trees.
 */
export const VXPK_META_FLAG_TREE_LOD = 1 << 0;
/**
 * META flag bit 1: the chunks also carry the MIDDLE tree level — the same
 * hulls carved at 2x2-px voxels (`MESH_KIND.treeCoarse`, ~1/4 the quads; the
 * art on the faces stays full-resolution because only geometry coarsens).
 * Without it, a rung asking for the coarse level draws the fine hulls
 * instead: more triangles, never fewer trees.
 */
export const VXPK_META_FLAG_TREE_COARSE = 1 << 1;
/**
 * META flag bit 2: eligible chunks carry a baked ground quad + page
 * (`MESH_KIND.groundBake`). Without it, `groundBakeDist` draws geometry
 * everywhere — slower, never wrong.
 */
export const VXPK_META_FLAG_GROUND_BAKE = 1 << 2;
/** The AUDI payload's own header (json_len, program_len, two pad words). */
export const VXPK_AUDIO_HEADER_SIZE = 16;
/** The VCOL payload's own header (version, counts, flags, two pad words). */
export const VXPK_COLOR_HEADER_SIZE = 16;
/** VCOL payload format version. */
export const VXPK_COLOR_VERSION = 1;
/** VCOL flag bit 0: the terrain page carries per-tile RED++ group indices. */
export const VXPK_COLOR_FLAG_WORLD = 1 << 0;
/** VCOL flag bit 1 (Gold): every world_pal and page_pal names the first of
 *  four consecutive palettes -- MORN, DAY, NITE, DARK -- and the `daytime`
 *  op picks among them. */
export const VXPK_COLOR_FLAG_DAYTIME = 1 << 1;
/** "no VCOL palette here" — fall through to the legacy binding. */
export const COLOR_PAL_NONE = 0xffff;

/** Section tags (4CC, LE u32). */
export const VXPK_TAG = {
  /** u32 counts + view meta; see cook/pak.ts for the packed shape. */
  meta: 0x4154454d, // 'META'
  /**
   * CLUT palettes: u16 count, then count * 256 u32 ABGR entries. The list
   * is the 4 ATLAS_KIND default (GB grayscale) palettes followed by the SGB
   * set; the `palette` op selects an SGB entry that REPLACES the color ramp
   * for non-ui kinds (ui always samples its own default).
   */
  palette: 0x4c415056, // 'VPAL'
  /**
   * Atlas pages: u16 count, then per page a 16-byte header
   * (u16 w | u16 h | u16 kind | u16 frames | u32 offset | u32 len) with
   * pre-swizzled CLUT8 texels; animated pages store `frames` variants
   * back-to-back.
   */
  atlas: 0x534c5441, // 'ATLS'
  /**
   * Per-map chunk meshes: map directory, then per chunk a header
   * (i16 cx | i16 cy | AABB i16[6] | per-mesh-kind vert/index ranges) over
   * shared 20-byte-vertex and u16-index pools. One range per `MESH_KIND`.
   */
  chunks: 0x4b4e4843, // 'CHNK'
  /** Removable stamps: per map, per (cx,cy) a small vert/index range. */
  stamps: 0x504d5453, // 'STMP'
  /**
   * Tree instances (v9): the same carved hull drawn in many places.
   *
   * Viridian Forest is 1,062 tree cells carved from 21 distinct shapes --
   * 3.1M vertices of which 59.5k are unique. Stamped out per cell they are
   * 37.5 MB, more than a 3DS can hold, so the cook had to drop detail and
   * then whole trees. Stored once and placed, they are ~1 MB and every tree
   * can be drawn: the shapes live in the CHNK pools like any other mesh, and
   * each instance names a near and a far one, so the renderer picks detail
   * per tree by distance instead of the cook picking it per chunk.
   *
   *   0  u16 map_count | 2 u16 pad
   *   4  u32 shape_total | 8 u32 inst_total | 12 u32 pad
   *   16 shape records, shape_total * VXPK_TREE_SHAPE_SIZE:
   *        u32 vert_base | u16 vert_count | u16 index_count | u32 index_base
   *        | u32 pad
   *   .. map directory, map_count * 12: u32 map_id | u32 first | u32 count
   *   .. instance records, inst_total * VXPK_TREE_INST_SIZE:
   *        i16 x | i16 y | i16 z | u16 near | u16 mid | u16 far
   *      (x, y, z is the shape's origin in map-local world px; near is the
   *      carved hull, mid the coarse carve, far the plain box, and any of
   *      them may be TREE_SHAPE_NONE)
   */
  trees: 0x534e4954, // 'TINS'
  /** GB charmap -> UI atlas tile, u16 pairs (for uiText). */
  charmap: 0x50414d43, // 'CMAP'
  /** The gameplay dataset the guest parses at boot (JSON bytes). */
  game: 0x454d4147, // 'GAME'
  /**
   * The chip synth's input, returned verbatim by the `audiodata` op:
   *   0  u32 json_len       audio.json (UTF-8), the header/song tables
   *   4  u32 program_len    programs.bin, the concatenated ROM sound banks
   *   8  u32 pad = 0 | 12 u32 pad = 0
   *   16 json bytes, then 16-aligned, program bytes
   * Both halves may be empty (a pak cooked without audio); the guest then
   * runs silent. See voxelmon/game/audio/banks.ts for the reader.
   */
  audio: 0x49445541, // 'AUDI'
  /**
   * Per-tile color bindings — RED++ / pokered-gbc parity, entirely pak-side
   * (no op, no guest change). The cooker bakes the RED++ palette GROUP into
   * the terrain texel index (`texel = group * 4 + shade`, 0..31; 0xff stays
   * transparent) and this section says which VPAL entry each draw resolves
   * that index through:
   *
   *   0  u16 version = VXPK_COLOR_VERSION
   *   2  u16 map_count      == the CHNK map count
   *   4  u16 page_count     == the ATLS page count
   *   6  u16 flags          VXPK_COLOR_FLAG_WORLD when the terrain page is
   *                         group-baked (so a world_pal is mandatory for
   *                         every map whose sheet was baked)
   *   8  u32 pad = 0 | 12 u32 pad = 0
   *   16 map_count * 8: u32 map_id | u16 world_pal | u16 terrain_page
   *   .. page_count * 2: u16 page_pal
   *
   * Every u16 palette/page index is either COLOR_PAL_NONE or a valid index;
   * the core range-validates all of them. Map records carry `map_id`
   * explicitly, so the section is order-independent of the CHNK directory.
   *
   * PRECEDENCE, for every textured draw: the item's own VCOL palette (a
   * chunk/stamp mesh takes its map slot's `world_pal`) wins, else the page's
   * `page_pal`, else the `palette` op's SGB selection (`VPAL[SGB_PAL_BASE +
   * i]`, non-ui kinds only), else the page kind's GB grayscale ramp. The ui
   * kind never takes a VCOL palette. A pak whose VCOL is all COLOR_PAL_NONE
   * renders exactly as a v2 pak did.
   */
  color: 0x4c4f4356, // 'VCOL'
} as const;

/** Atlas page kinds. */
export const ATLAS_KIND = {
  terrain: 0,
  sprites: 1,
  ui: 2,
  pics: 3,
} as const;

/**
 * The GE world vertex (v8):
 *   u16 u | u16 v | u32 abgr | i16 x | i16 y | i16 z | i16 pad  = 16 bytes.
 * UVs are page-normalized fixed point — round(uv * 32768), clamped to
 * 32767 — matching the GE's TEXTURE_16BIT semantics in TRANSFORM_3D (the
 * hardware divides by 32768; the software rasterizer divides identically,
 * so both backends sample the same quantized coordinate). i16 positions
 * are countered by a x32768 model scale on the GE. The 20-byte f32-UV
 * vertex this replaces cost 25% more GE fetch bytes on a fetch-bound part.
 */
export const VERTEX_STRIDE = 16;
/** A batch seals before u16 index overflow. */
export const MAX_VERTS_PER_CHUNK_MESH = 65532;

// ---------------------------------------------------------------------------
// Mesh kinds inside a chunk — draw order is their numeric order
// ---------------------------------------------------------------------------

export const MESH_KIND = {
  terrain: 0,
  /**
   * The chunk's BAKED GROUND: one textured quad drawn INSTEAD of this
   * chunk's terrain + grass + flower meshes past `groundBakeDist` (§quality
   * ladder). The texture is the cook's oblique projection of those quads
   * onto the y=0 plane at the rung-2 rest pitch, composited in CLUT-index
   * space on the chunk's own bake page (`Chunk.bake_page`), so palettes and
   * the day tint apply unchanged. Only low-relief chunks bake (docs §4a);
   * a chunk with an empty range here is ineligible and always draws its
   * geometry.
   */
  groundBake: 1,
  /**
   * A baked chunk's KEPT structures: every terrain quad taller than the
   * bake line (fences, signs, the border tree walls, buildings), duplicated
   * out of the full terrain stream at pack time. Drawn WITH the bake quad
   * in place of `terrain`; the full stream stays untouched for the rungs
   * (and moments) that draw geometry, so the identity anchor never moves.
   */
  terrainKeep: 2,
  /**
   * Carved round-scenery hulls (trees), the NEAR level of detail. Cooked out
   * of the terrain stream into their own range so the runtime can swap them
   * per chunk; drawn immediately after their own chunk's terrain, which is
   * exactly where they sat inside it.
   */
  treeHull: 3,
  /**
   * The MIDDLE level: the same hulls carved at 2x2-px voxels — ~1/4 the
   * quads, full-resolution art on the faces (UVs interpolate the original
   * texels; only the silhouette quantises to 2 px). The three tree kinds are
   * alternatives inside the terrain pass: a chunk draws exactly one, chosen
   * by `treeHullDist`/`treeCoarseDist`.
   */
  treeCoarse: 4,
  /** The same cells as plain extruded boxes: the FAR level of detail. */
  treeBox: 5,
  water: 6,
  grass: 7,
  flower: 8,
} as const;
export const MESH_KINDS = 9;

/**
 * Bytes per CHNK chunk record: i16 cx | i16 cy | i16 AABB[6] | u16
 * bake_page (0xffff = no bake) | u16 pad | one 12-byte mesh range per
 * MESH_KIND. Both writers size the directory with this.
 */
export const VXPK_CHUNK_RECORD_SIZE = 20 + MESH_KINDS * 12;
/** `Chunk.bake_page` value for "this chunk has no baked ground". */
export const BAKE_PAGE_NONE = 0xffff;
