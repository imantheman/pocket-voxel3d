// Camera centred on the player. A port of gen1recomp src/render/Camera.lua at
// bdfac727 (MIT).
//
// At the default 160x144 view this is the original framing (player sprite at
// screen tile (8,8) -> pixel (64, 60) after the -4px sprite offset); wider or
// taller world-pass views keep the player at the same relative centre. On
// the 3DS the view is always 160x144 (Zoom is inert); the voxel renderer
// reads camera.x / camera.y (map pixels of the view's top-left) through
// World:viewState().

export class Camera {
  x: number;
  y: number;

  constructor() {
    this.x = 0;
    this.y = 0;
  }

  // Lua: Camera.lua:10-12
  static new(): Camera {
    return new Camera();
  }

  // Lua: Camera.lua:14-18
  follow(px: number, py: number, viewW?: number, viewH?: number): void {
    const vw = viewW ?? 160;
    const vh = viewH ?? 144;
    this.x = px - (vw / 2 - 16);
    this.y = py - (vh / 2 - 8);
  }
}

export default Camera;
