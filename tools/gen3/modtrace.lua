-- Port tooling (GPLv3 + additional terms; see voxelmon/import/gen3/LICENSE.md):
-- run full_extract.lua with require traced; write each module loaded, its
-- loader (the module that first required it) and its line count.
--   cd ~/gen1recomp-latest
--   luajit /home/isaac/pocket-voxel/tools/gen3/modtrace.lua TRACEFILE OUTDIR ROM SHA1
local traceFile = table.remove(arg, 1)
local seen, order, stack = {}, {}, {}
local real = require
_G.require = function(name)
  if not seen[name] then
    seen[name] = { parent = stack[#stack] or "-" }
    order[#order + 1] = name
  end
  stack[#stack + 1] = name
  local ok, res = pcall(real, name)
  stack[#stack] = nil
  if not ok then error(res, 2) end
  return res
end
local function lines(name)
  local path = name:gsub("%.", "/") .. ".lua"
  local f = io.open(path, "r")
  if not f then return 0 end
  local n = 0
  for _ in f:lines() do n = n + 1 end
  f:close()
  return n
end
local chunk = assert(loadfile("/home/isaac/pocket-voxel/tools/gen3/full_extract.lua"))
local ok, err = pcall(chunk, unpack(arg))
local out = io.open(traceFile, "w")
for _, n in ipairs(order) do out:write(string.format("%s\t%d\t%s\n", n, lines(n), seen[n].parent)) end
out:close()
if not ok then io.stderr:write("run failed: ", tostring(err), "\n") end
