-- Port tooling (GPLv3 + additional terms; see voxelmon/import/gen3/LICENSE.md):
-- write gen1recomp's RevisionView rebuild of a 1.1 ROM (its 1.0 layout) to a file.
--   cd ~/gen1recomp-latest && luajit .../revview_dump.lua ROM SHA1 OUT
package.path = "./?.lua;./?/init.lua;" .. package.path
local RevisionView = require("src.import.gba.revision_view")
local f = assert(io.open(arg[1], "rb")); local rom = f:read("*a"); f:close()
local out = RevisionView.apply(rom, arg[2])
local o = assert(io.open(arg[3], "wb")); o:write(out); o:close()
print(#out)
