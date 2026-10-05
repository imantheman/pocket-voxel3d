// Port of gen1recomp src/core/game3/cache_paths.lua (GPLv3 + additional terms; see LICENSE.md).

export const CachePaths = {
  CACHE_ROOT: "data/generated/gba",
  NATIVE_ROOT: "data/generated/gba/native",
  setRoot(root: string): boolean {
    if (typeof root !== "string" || root === "") return false;
    CachePaths.CACHE_ROOT = root;
    CachePaths.NATIVE_ROOT = root + "/native";
    return true;
  },
  reset(): void {
    CachePaths.CACHE_ROOT = "data/generated/gba";
    CachePaths.NATIVE_ROOT = "data/generated/gba/native";
  },
};

export default CachePaths;
