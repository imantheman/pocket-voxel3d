-- Port tooling for gen1recomp's FireRed importer (GPLv3 + additional terms;
-- see voxelmon/import/gen3/LICENSE.md). Runs his RomExtractorGen3 plan -- every
-- stage, sequentially -- under plain luajit, with small stand-ins for the
-- LOVE calls it makes, so each stage of our TypeScript importer has a
-- reference cache to be byte-compared against.
--
--   cd ~/gen1recomp-latest
--   luajit /home/isaac/pocket-voxel/tools/gen3/full_extract.lua OUTDIR ROM SHA1
--
-- PNGs written through the stand-in encoder are stored-deflate (compare
-- them by pixels, not bytes).
package.path = "./?.lua;./?/init.lua;" .. package.path
local OUT, ROM, SHA1 = arg[1], arg[2], arg[3]
assert(OUT and ROM and SHA1, "usage: full_extract.lua OUTDIR ROM SHA1")

local function mkdirs(path)
  os.execute("mkdir -p '" .. path:gsub("'", "'\\''") .. "'")
end
local function abs(rel) return OUT .. "/" .. rel end

-- ---------------------------------------------------------------- PNG out
local bit = require("bit")
local crcTable = {}
for i = 0, 255 do
  local c = i
  for _ = 1, 8 do
    if bit.band(c, 1) == 1 then c = bit.bxor(0xEDB88320, bit.rshift(c, 1)) else c = bit.rshift(c, 1) end
  end
  crcTable[i] = c
end
local function crc32(s)
  local c = 0xFFFFFFFF
  for i = 1, #s do c = bit.bxor(crcTable[bit.band(bit.bxor(c, s:byte(i)), 0xFF)], bit.rshift(c, 8)) end
  return bit.bxor(c, 0xFFFFFFFF)
end
local function u32(n)
  n = n % 4294967296
  return string.char(math.floor(n / 16777216) % 256, math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256)
end
local function adler32(s)
  local a, b = 1, 0
  for i = 1, #s do a = (a + s:byte(i)) % 65521; b = (b + a) % 65521 end
  return b * 65536 + a
end
local function zlibStored(raw)
  local parts = { "\120\1" }
  local pos, n = 1, #raw
  repeat
    local len = math.min(65535, n - pos + 1)
    local final = (pos + len > n) and 1 or 0
    parts[#parts + 1] = string.char(final, len % 256, math.floor(len / 256), (65535 - len) % 256, math.floor((65535 - len) / 256))
    parts[#parts + 1] = raw:sub(pos, pos + len - 1)
    pos = pos + len
  until pos > n
  parts[#parts + 1] = u32(adler32(raw))
  return table.concat(parts)
end
local function chunk(kind, data) return u32(#data) .. kind .. data .. u32(crc32(kind .. data)) end
local function encodePng(w, h, rgba)
  local rows = {}
  for y = 0, h - 1 do rows[#rows + 1] = "\0" .. rgba:sub(y * w * 4 + 1, (y + 1) * w * 4) end
  return "\137PNG\r\n\26\n" .. chunk("IHDR", u32(w) .. u32(h) .. "\8\6\0\0\0")
    .. chunk("IDAT", zlibStored(table.concat(rows))) .. chunk("IEND", "")
end

-- ---------------------------------------------------------------- ImageData
local function clampByte(v) v = math.floor(v * 255 + 0.5); if v < 0 then v = 0 elseif v > 255 then v = 255 end; return v end
local ImageData = {}
ImageData.__index = ImageData
-- reads back only what encodePng above writes: RGBA8, filter 0, stored deflate
local function be32(s, i) return ((s:byte(i) * 256 + s:byte(i + 1)) * 256 + s:byte(i + 2)) * 256 + s:byte(i + 3) end
local function decodeOwnPng(png)
  assert(png:sub(1, 8) == "\137PNG\r\n\26\n", "not a png")
  local pos, w, h, idat = 9, nil, nil, {}
  while pos < #png do
    local len, kind = be32(png, pos), png:sub(pos + 4, pos + 7)
    local data = png:sub(pos + 8, pos + 7 + len)
    if kind == "IHDR" then w, h = be32(data, 1), be32(data, 5)
    elseif kind == "IDAT" then idat[#idat + 1] = data end
    pos = pos + 12 + len
  end
  local z = table.concat(idat)
  local raw, zp = {}, 3
  while true do
    local final, len = z:byte(zp), z:byte(zp + 1) + z:byte(zp + 2) * 256
    assert(final == 0 or final == 1, "only stored deflate")
    raw[#raw + 1] = z:sub(zp + 5, zp + 4 + len)
    zp = zp + 5 + len
    if final == 1 then break end
  end
  local r, rows = table.concat(raw), {}
  for y = 0, h - 1 do rows[#rows + 1] = r:sub(y * (w * 4 + 1) + 2, (y + 1) * (w * 4 + 1)) end
  return w, h, table.concat(rows)
end
local function newImageData(w, h, _fmt, bytes)
  if type(w) == "table" and w.pngBytes then
    local pw, ph, rgba = decodeOwnPng(w.pngBytes)
    w, h, bytes = pw, ph, rgba
  elseif type(w) ~= "number" then error("ImageData from file not supported in the stand-in") end
  local self = setmetatable({ w = w, h = h, px = {} }, ImageData)
  local n = w * h * 4
  if type(bytes) == "string" then
    for i = 1, n do self.px[i] = bytes:byte(i) or 0 end
  else
    for i = 1, n do self.px[i] = 0 end
  end
  return self
end
function ImageData:getWidth() return self.w end
function ImageData:getHeight() return self.h end
function ImageData:getDimensions() return self.w, self.h end
function ImageData:setPixel(x, y, r, g, b, a)
  if type(r) == "table" then r, g, b, a = r[1], r[2], r[3], r[4] end
  local o = (y * self.w + x) * 4
  self.px[o + 1], self.px[o + 2], self.px[o + 3], self.px[o + 4] = clampByte(r), clampByte(g), clampByte(b), clampByte(a or 1)
end
function ImageData:getPixel(x, y)
  local o = (y * self.w + x) * 4
  return self.px[o + 1] / 255, self.px[o + 2] / 255, self.px[o + 3] / 255, self.px[o + 4] / 255
end
function ImageData:mapPixel(fn, x0, y0, w, h)
  x0, y0, w, h = x0 or 0, y0 or 0, w or self.w, h or self.h
  for y = y0, y0 + h - 1 do for x = x0, x0 + w - 1 do self:setPixel(x, y, fn(x, y, self:getPixel(x, y))) end end
end
function ImageData:paste(src, dx, dy, sx, sy, sw, sh)
  sx, sy, sw, sh = sx or 0, sy or 0, sw or src.w, sh or src.h
  for y = 0, sh - 1 do for x = 0, sw - 1 do
    local tx, ty = dx + x, dy + y
    if tx >= 0 and ty >= 0 and tx < self.w and ty < self.h then
      local so, to = ((sy + y) * src.w + sx + x) * 4, (ty * self.w + tx) * 4
      for k = 1, 4 do self.px[to + k] = src.px[so + k] end
    end
  end end
end
function ImageData:getString()
  local t = {}
  for i = 1, #self.px do t[i] = string.char(self.px[i]) end
  return table.concat(t)
end
function ImageData:encode(fmt, filename)
  assert(fmt == "png", "only png")
  local data = encodePng(self.w, self.h, self:getString())
  local fd = { getString = function() return data end }
  if filename then love.filesystem.write(filename, data) end
  return fd
end
function ImageData:release() end
function ImageData:type() return "ImageData" end
function ImageData:typeOf(t) return t == "ImageData" or t == "Data" or t == "Object" end

-- ---------------------------------------------------------------- love
_G.love = {
  filesystem = {
    write = function(rel, data)
      local dir = rel:match("^(.*)/[^/]+$")
      if dir then mkdirs(abs(dir)) end
      local f = assert(io.open(abs(rel), "wb"))
      if type(data) ~= "string" and data.getString then data = data:getString() end
      f:write(data); f:close()
      return true
    end,
    read = function(rel)
      local f = io.open(abs(rel), "rb")
      if not f then return nil end
      local d = f:read("*a"); f:close(); return d, #d
    end,
    getInfo = function(rel)
      local f = io.open(abs(rel), "rb")
      if f then f:close(); return { type = "file" } end
      local ok = os.execute("test -d '" .. abs(rel) .. "'")
      if ok == 0 or ok == true then return { type = "directory" } end
      return nil
    end,
    createDirectory = function(rel) mkdirs(abs(rel)); return true end,
    remove = function(rel) os.remove(abs(rel)); return true end,
    newFileData = function(bytes, name) return { pngBytes = bytes, name = name } end,
    getDirectoryItems = function(rel)
      local items, p = {}, io.popen("ls -1 '" .. abs(rel) .. "' 2>/dev/null")
      for line in p:lines() do items[#items + 1] = line end
      p:close(); return items
    end,
  },
  image = {
    newImageData = newImageData,
  },
  data = {
    encode = function(container, fmt, data)
      assert(fmt == "hex")
      return (data:gsub(".", function(c) return string.format("%02x", c:byte()) end))
    end,
  },
  system = {
    getOS = function() return "Linux" end,
    getProcessorCount = function() return 1 end,
  },
}

-- ---------------------------------------------------------------- run
mkdirs(OUT)
local f = assert(io.open(ROM, "rb"))
local romData = f:read("*a"); f:close()
local Extract = require("src.import.gba.extract_island1")
Extract.CACHE_ROOT = "data/generated/gba"
Extract.NATIVE_ROOT = "data/generated/gba/native"
local RomExtractorGen3 = require("src.import.RomExtractorGen3")
local ex = RomExtractorGen3.new(romData, nil, function(pct, label) io.write(string.format("[%3d%%] %s\n", math.floor((pct or 0) * 100), tostring(label))) end, SHA1)
local t0 = os.clock()
local ok, res = pcall(function() return ex:run() end)
print(string.format("done in %.1fs: %s", os.clock() - t0, ok and "ok" or ("FAILED " .. tostring(res))))
if ok then for k, v in pairs(res) do print("", k, tostring(v)) end end
