// The FireRed runtime port, cluster "battle animation, anim_port group 1":
// voxelmon/game/gen3/core/battle/anim_port/ g1_pret, g1_sprite, g1_task_base,
// g1_pic_sizes, g1_templates, g1_tasks(_b), g1_callbacks(_b), g2_pret.
//
// Reference: gen1recomp's own anim.lua / anim_vm.lua under luajit on the
// FireRed cache (~/gen3ref/frfull), love stubbed (.cc_ap1_oracle.lua, a copy of
// .cc_ban_oracle.lua with a `g1only` mode that blocks the g2..g5 groups and
// g4_pret, so the g1 groups run exactly as the port has them). The TS run
// drops every anim_port G3Lazy entry but g1's before the groups merge, so both
// sides run the same groups. Run this file on its own (bun shares modules
// between test files; the groups merge once per process).
//   TACKLE: 29 frames without anim_port, 25 with g1 (and with all groups).
// The helper values (g2_pret / g1_pret math, translations, anim and affine
// runners) are Brian's modules under luajit (.cc_ap1_g2.lua).
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { format } from "../voxelmon/import/gen3/lua.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROOT = join(homedir(), "gen3ref/frfull");
const TACKLE = 33;

function parseRows(s: string): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  for (const w of s.trim().split(/\s+/)) {
    const [id, f, m] = w.split(":").map(Number);
    out[id!] = [f!, m!];
  }
  return out;
}

// Brian's VM under luajit with only the g1 groups (g2..g5 tasks/callbacks and g4_pret
// blocked): "move:frames:maxSprites" for moves 1..354 (.cc_ap1_oracle.lua g1only).
const ORACLE_G1 = parseRows(`
1:17:1 2:35:1 3:17:1 4:20:2 5:150:1 6:43:2 7:89:9 8:176:10 9:112:4 10:27:1 11:31:3 12:153:2 13:23:3 14:51:1
15:32:1 16:53:1 17:77:2 18:64:6 19:26:1 20:41:0 21:46:2 22:31:1 23:47:1 24:20:1 25:150:1 26:38:1 27:78:2
28:52:25 29:40:1 30:47:1 31:31:1 32:186:3 33:25:1 34:101:1 35:37:0 36:92:1 37:97:1 38:140:1 39:64:0 40:96:3
41:45:2 42:76:2 43:56:1 44:35:3 45:51:3 46:94:3 47:150:12 48:58:6 49:46:3 50:69:1 51:104:3 52:65:3 53:123:5
54:298:2 55:95:3 56:108:14 57:91:0 58:194:18 59:261:8 60:155:3 61:194:4 62:212:6 63:279:13 64:18:1 65:82:0
66:101:1 67:51:2 68:82:3 69:124:9 70:93:2 71:200:6 72:212:12 73:134:3 74:65:0 75:150:10 76:103:5 77:196:15
78:193:15 79:193:15 80:238:13 81:150:6 82:169:8 83:103:8 84:155:4 85:241:9 86:83:4 87:256:4 88:59:3 89:197:0
90:248:4 91:215:6 92:222:3 93:135:0 94:135:0 95:164:6 96:168:0 97:74:2 98:25:3 99:75:1 100:90:0 101:201:0
102:101:1 103:62:2 104:134:2 105:174:3 106:30:0 107:144:0 108:74:12 109:218:1 110:74:0 111:106:1 112:42:1
113:81:4 114:158:0 115:69:3 116:121:4 117:64:0 118:126:2 119:17:1 120:116:3 121:74:4 122:52:1 123:252:2
124:77:4 125:36:1 126:192:15 127:153:13 128:32:3 129:72:5 130:113:0 131:51:3 132:82:4 133:142:1 134:245:3
135:262:3 136:85:1 137:99:2 138:256:17 139:228:3 140:71:0 141:231:6 142:14:4 143:123:0 144:50:0 145:151:4
146:75:14 147:201:6 148:41:0 149:200:3 150:89:18 151:83:0 152:105:4 153:216:3 154:43:1 155:66:1 156:109:3
157:117:5 158:105:1 159:291:1 160:181:16 161:223:8 162:199:1 163:45:2 164:17:0 165:75:2 166:67:18 167:28:2
168:124:1 169:126:6 170:101:7 171:152:0 172:154:7 173:64:3 174:281:1 175:86:1 176:176:16 177:210:8 178:198:6
179:170:6 180:208:0 181:215:4 182:117:1 183:100:10 184:144:2 185:203:1 186:80:6 187:109:5 188:166:12 189:50:25
190:57:4 191:59:3 192:99:9 193:161:1 194:177:0 195:257:17 196:260:6 197:109:1 198:34:1 199:149:5 200:95:10
201:125:3 202:224:17 203:121:4 204:68:2 205:92:1 206:76:6 207:139:1 208:195:3 209:122:8 210:32:1 211:78:2
212:165:1 213:285:8 214:145:3 215:284:6 216:82:1 217:171:3 218:191:2 219:86:3 220:112:2 221:174:8 222:181:0
223:76:3 224:169:2 225:88:6 226:53:1 227:216:6 228:92:1 229:95:1 230:175:9 231:36:1 232:38:2 233:113:1
234:238:3 235:133:3 236:348:6 237:178:8 238:73:2 239:183:12 240:186:0 241:144:4 242:131:3 243:81:4 244:173:1
245:191:1 246:92:8 247:127:1 248:106:0 249:45:8 250:117:8 251:30:2 252:83:0 253:80:6 254:94:5 255:94:10
256:141:5 257:127:3 258:115:0 259:51:1 260:138:39 261:160:6 262:112:0 263:76:0 264:143:2 265:92:2 266:184:1
267:92:8 268:217:2 269:102:2 270:63:2 271:200:2 272:129:0 273:224:2 274:22:1 275:163:7 276:242:3 277:42:1
278:89:1 279:130:2 280:144:2 281:91:3 282:47:1 283:57:1 284:347:10 285:166:0 286:117:1 287:135:2 288:172:0
289:27:0 290:93:2 291:48:11 292:51:1 293:141:0 294:124:1 295:321:2 296:158:1 297:71:7 298:159:2 299:83:8
300:173:18 301:56:5 302:106:10 303:68:3 304:68:1 305:111:3 306:53:2 307:102:9 308:144:9 309:209:2 310:50:2
311:142:1 312:324:9 313:58:2 314:61:1 315:218:24 316:57:0 317:161:1 318:175:18 319:80:4 320:182:12 321:201:2
322:235:2 323:107:0 324:145:12 325:98:10 326:149:0 327:178:4 328:123:8 329:108:0 330:65:0 331:84:2 332:32:3
333:76:2 334:30:0 335:6:1 336:80:3 337:143:10 338:179:12 339:94:1 340:26:1 341:139:5 342:3655:4 343:86:2
344:185:7 345:168:10 346:216:18 347:102:2 348:184:12 349:104:6 350:46:5 351:183:4 352:131:5 353:84:0 354:384:1
`);
// Moves whose count depends on math.random (the oracle's count changes with the seed).
const RANDOM_MOVES = new Set([40, 55, 61, 63, 92, 124, 127, 145, 152, 188, 305, 342, 352]);
// Moves the g1 groups complete on their own: g1-only count == full anim_port count != noport.
const G1_COMPLETE = [
  1, 3, 4, 9, 10, 15, 20, 21, 22, 29, 30, 31, 32, 33, 36, 38, 41, 42, 44, 46, 47, 48, 49, 60, 64, 68, 70, 71,
  72, 73, 74, 75, 76, 77, 78, 79, 80, 93, 94, 95, 98, 99, 102, 103, 104, 105, 116, 117, 118, 119, 120, 121, 128,
  129, 130, 132, 138, 147, 148, 153, 156, 159, 160, 162, 163, 168, 173, 176, 177, 178, 179, 182, 183, 187, 190,
  193, 195, 199, 202, 203, 206, 208, 210, 212, 216, 217, 226, 228, 233, 235, 236, 237, 239, 241, 242, 244, 248,
  251, 264, 266, 271, 275, 289, 290, 302, 307, 311, 318, 320, 322, 325, 332, 333, 338, 345, 347, 348, 349, 353,
  354
];
const ORACLE_FULL: Record<number, number> = {
  1: 17, 3: 17, 4: 20, 9: 112, 10: 27, 15: 32, 20: 41, 21: 46, 22: 31, 29: 40, 30: 47, 31: 31, 32: 186, 33: 25,
  36: 92, 38: 140, 41: 45, 42: 76, 44: 35, 46: 94, 47: 150, 48: 58, 49: 46, 60: 155, 64: 18, 68: 82, 70: 93, 71:
  200, 72: 212, 73: 134, 74: 65, 75: 150, 76: 103, 77: 196, 78: 193, 79: 193, 80: 238, 93: 135, 94: 135, 95:
  164, 98: 25, 99: 75, 102: 101, 103: 62, 104: 134, 105: 174, 116: 121, 117: 64, 118: 126, 119: 17, 120: 116,
  121: 74, 128: 32, 129: 72, 130: 113, 132: 82, 138: 256, 147: 201, 148: 41, 153: 216, 156: 109, 159: 291, 160:
  181, 162: 199, 163: 45, 168: 124, 173: 64, 176: 176, 177: 210, 178: 198, 179: 170, 182: 117, 183: 100, 187:
  109, 190: 57, 193: 161, 195: 257, 199: 149, 202: 224, 203: 121, 206: 76, 208: 195, 210: 32, 212: 165, 216: 82,
  217: 171, 226: 53, 228: 92, 233: 113, 235: 133, 236: 348, 237: 178, 239: 183, 241: 144, 242: 131, 244: 173,
  248: 106, 251: 30, 264: 143, 266: 184, 271: 200, 275: 163, 289: 27, 290: 93, 302: 106, 307: 102, 311: 142,
  318: 175, 320: 182, 322: 235, 325: 98, 332: 32, 333: 76, 338: 179, 345: 168, 347: 102, 348: 184, 349: 104,
  353: 84, 354: 384
};
const ORACLE_NOPORT: Record<number, number> = {
  1: 21, 3: 21, 4: 24, 9: 332, 10: 20, 15: 33, 20: 40, 21: 45, 22: 32, 29: 36, 30: 54, 31: 41, 32: 195, 33: 29,
  36: 96, 38: 144, 41: 47, 42: 80, 44: 37, 46: 97, 47: 137, 48: 55, 49: 47, 60: 166, 64: 19, 68: 83, 70: 97, 71:
  188, 72: 204, 73: 115, 74: 63, 75: 151, 76: 100, 77: 194, 78: 191, 79: 191, 80: 237, 93: 126, 94: 126, 95:
  178, 98: 27, 99: 73, 102: 63, 103: 61, 104: 132, 105: 176, 116: 123, 117: 70, 118: 87, 119: 21, 120: 105, 121:
  54, 128: 36, 129: 59, 130: 99, 132: 54, 138: 252, 147: 276, 148: 2, 153: 203, 156: 75, 159: 31, 160: 140, 162:
  220, 163: 46, 168: 125, 173: 53, 176: 154, 177: 216, 178: 273, 179: 184, 182: 41, 183: 104, 187: 143, 190: 52,
  193: 182, 195: 274, 199: 126, 202: 220, 203: 123, 206: 75, 208: 137, 210: 33, 212: 174, 216: 74, 217: 104,
  226: 50, 228: 95, 233: 115, 235: 153, 236: 271, 237: 195, 239: 108, 241: 143, 242: 136, 244: 202, 248: 105,
  251: 34, 264: 144, 266: 143, 271: 194, 275: 144, 289: 26, 290: 105, 302: 105, 307: 320, 311: 100, 318: 129,
  320: 149, 322: 215, 325: 102, 332: 33, 333: 80, 338: 142, 345: 167, 347: 72, 348: 183, 349: 84, 353: 81, 354:
  393
};
// Sprite dumps (tag x y ox oy of every active sprite) at one frame, g1-only oracle.
const SPRITE_DUMPS: Record<string, string> = {
  "160:90": "S CONVERSION x=48 y=56 ox=0 oy=0\nS CONVERSION x=64 y=56 ox=0 oy=0\nS CONVERSION x=80 y=56 ox=0 oy=0\nS CONVERSION x=96 y=56 ox=0 oy=0\nS CONVERSION x=48 y=72 ox=0 oy=0\nS CONVERSION x=64 y=72 ox=0 oy=0\nS CONVERSION x=80 y=72 ox=0 oy=0\nS CONVERSION x=96 y=72 ox=0 oy=0\nS CONVERSION x=48 y=88 ox=0 oy=0\nS CONVERSION x=64 y=88 ox=0 oy=0\nS CONVERSION x=80 y=88 ox=0 oy=0\nS CONVERSION x=96 y=88 ox=0 oy=0\nS CONVERSION x=48 y=104 ox=0 oy=0\nS CONVERSION x=64 y=104 ox=0 oy=0\nS CONVERSION x=80 y=104 ox=0 oy=0\nS CONVERSION x=96 y=104 ox=0 oy=0",
  "202:100": "S ORBS x=176 y=45 ox=-72 oy=35\nS ORBS x=171 y=55 ox=-36 oy=44\nS ORBS x=176 y=45 ox=-24 oy=14\nS ORBS x=186 y=35 ox=-52 oy=16\nS ORBS x=166 y=60 ox=-28 oy=24\nS ORBS x=176 y=45 ox=-24 oy=14\nS ORBS x=181 y=22 ox=-18 oy=1\nS ORBS x=176 y=25 ox=-86 oy=43\nS ORBS x=171 y=55 ox=-72 oy=36\nS ORBS x=176 y=25 ox=-69 oy=28\nS ORBS x=176 y=45 ox=-96 oy=40\nS ORBS x=171 y=55 ox=-54 oy=33\nS ORBS x=186 y=35 ox=-78 oy=2",
  "47:40": "S MUSIC_NOTES x=164 y=46 ox=0 oy=-15\nS MUSIC_NOTES x=147 y=54 ox=0 oy=-8\nS MUSIC_NOTES x=129 y=62 ox=0 oy=4\nS MUSIC_NOTES x=112 y=70 ox=0 oy=13\nS MUSIC_NOTES x=94 y=77 ox=0 oy=13\nS MUSIC_NOTES x=79 y=84 ox=0 oy=5",
  "75:50": "S LEAF x=42 y=68 ox=23 oy=13\nS LEAF x=57 y=73 ox=-19 oy=9\nS LEAF x=44 y=60 ox=21 oy=11\nS LEAF x=105 y=55 ox=-15 oy=7\nS LEAF x=64 y=40 ox=13 oy=6\nS LEAF x=96 y=76 ox=-5 oy=2\nS LEAF x=33 y=36 ox=0 oy=0\nS LEAF x=100 y=53 ox=-2 oy=1\nS LEAF x=84 y=52 ox=0 oy=0\nS LEAF x=66 y=78 ox=0 oy=0",
};
// Per-frame mon offsets / blend coeffs / bg blend ("P frame p0.ox p0.oy p1.ox p1.oy k0 k1 bg").
const PRESENT_DUMPS: Record<number, string> = {
  148: "P 1 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 2 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 3 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 4 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 5 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 6 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 7 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 8 0.0000 0.0000 0.0000 0.0000 1.0000 1.0000 16:32767\nP 9 0.0000 0.0000 0.0000 0.0000 0.9375 0.9375 15:32767\nP 10 0.0000 0.0000 0.0000 0.0000 0.9375 0.9375 15:32767\nP 11 0.0000 0.0000 0.0000 0.0000 0.8750 0.8750 14:32767\nP 12 0.0000 0.0000 0.0000 0.0000 0.8750 0.8750 14:32767\nP 13 0.0000 0.0000 0.0000 0.0000 0.8125 0.8125 13:32767\nP 14 0.0000 0.0000 0.0000 0.0000 0.8125 0.8125 13:32767\nP 15 0.0000 0.0000 0.0000 0.0000 0.7500 0.7500 12:32767\nP 16 0.0000 0.0000 0.0000 0.0000 0.7500 0.7500 12:32767\nP 17 0.0000 0.0000 0.0000 0.0000 0.6875 0.6875 11:32767\nP 18 0.0000 0.0000 0.0000 0.0000 0.6875 0.6875 11:32767\nP 19 0.0000 0.0000 0.0000 0.0000 0.6250 0.6250 10:32767\nP 20 0.0000 0.0000 0.0000 0.0000 0.6250 0.6250 10:32767\nP 21 0.0000 0.0000 0.0000 0.0000 0.5625 0.5625 9:32767\nP 22 0.0000 0.0000 0.0000 0.0000 0.5625 0.5625 9:32767\nP 23 0.0000 0.0000 0.0000 0.0000 0.5000 0.5000 8:32767\nP 24 0.0000 0.0000 0.0000 0.0000 0.5000 0.5000 8:32767\nP 25 0.0000 0.0000 0.0000 0.0000 0.4375 0.4375 7:32767\nP 26 0.0000 0.0000 0.0000 0.0000 0.4375 0.4375 7:32767\nP 27 0.0000 0.0000 0.0000 0.0000 0.3750 0.3750 6:32767\nP 28 0.0000 0.0000 0.0000 0.0000 0.3750 0.3750 6:32767\nP 29 0.0000 0.0000 0.0000 0.0000 0.3125 0.3125 5:32767\nP 30 0.0000 0.0000 0.0000 0.0000 0.3125 0.3125 5:32767\nP 31 0.0000 0.0000 0.0000 0.0000 0.2500 0.2500 4:32767\nP 32 0.0000 0.0000 0.0000 0.0000 0.2500 0.2500 4:32767\nP 33 0.0000 0.0000 0.0000 0.0000 0.1875 0.1875 3:32767\nP 34 0.0000 0.0000 0.0000 0.0000 0.1875 0.1875 3:32767\nP 35 0.0000 0.0000 0.0000 0.0000 0.1250 0.1250 2:32767\nP 36 0.0000 0.0000 0.0000 0.0000 0.1250 0.1250 2:32767\nP 37 0.0000 0.0000 0.0000 0.0000 0.0625 0.0625 1:32767\nP 38 0.0000 0.0000 0.0000 0.0000 0.0625 0.0625 1:32767\nP 39 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 40 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 41 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -",
  33: "P 1 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 2 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 3 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 4 4.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 5 8.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 6 12.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 7 16.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 8 16.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 9 16.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 10 12.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 11 8.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 12 4.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 13 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 14 0.0000 0.0000 3.0000 0.0000 0.0000 0.0000 -\nP 15 0.0000 0.0000 3.0000 0.0000 0.0000 0.0000 -\nP 16 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 17 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 18 0.0000 0.0000 3.0000 0.0000 0.0000 0.0000 -\nP 19 0.0000 0.0000 3.0000 0.0000 0.0000 0.0000 -\nP 20 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 21 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 22 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 23 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 24 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 25 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -",
  99: "P 1 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 2 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 3 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 4 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 5 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 6 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 7 0.0000 0.0000 0.0000 0.0000 0.0625 0.0000 -\nP 8 0.0000 0.0000 0.0000 0.0000 0.1250 0.0000 -\nP 9 0.0000 0.0000 0.0000 0.0000 0.1875 0.0000 -\nP 10 0.0000 0.0000 0.0000 0.0000 0.2500 0.0000 -\nP 11 0.0000 0.0000 0.0000 0.0000 0.3125 0.0000 -\nP 12 0.0000 0.0000 0.0000 0.0000 0.3750 0.0000 -\nP 13 0.0000 0.0000 0.0000 0.0000 0.4375 0.0000 -\nP 14 0.0000 0.0000 0.0000 0.0000 0.5000 0.0000 -\nP 15 0.0000 0.0000 0.0000 0.0000 0.5625 0.0000 -\nP 16 0.0000 0.0000 0.0000 0.0000 0.6250 0.0000 -\nP 17 0.0000 0.0000 0.0000 0.0000 0.5625 0.0000 -\nP 18 0.0000 0.0000 0.0000 0.0000 0.5000 0.0000 -\nP 19 0.0000 0.0000 0.0000 0.0000 0.4375 0.0000 -\nP 20 0.0000 0.0000 0.0000 0.0000 0.3750 0.0000 -\nP 21 0.0000 0.0000 0.0000 0.0000 0.3125 0.0000 -\nP 22 0.0000 0.0000 0.0000 0.0000 0.2500 0.0000 -\nP 23 0.0000 0.0000 0.0000 0.0000 0.1875 0.0000 -\nP 24 0.0000 0.0000 0.0000 0.0000 0.1250 0.0000 -\nP 25 0.0000 0.0000 0.0000 0.0000 0.0625 0.0000 -\nP 26 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 27 0.0000 0.0000 0.0000 0.0000 0.0625 0.0000 -\nP 28 0.0000 0.0000 0.0000 0.0000 0.1250 0.0000 -\nP 29 0.0000 0.0000 0.0000 0.0000 0.1875 0.0000 -\nP 30 0.0000 0.0000 0.0000 0.0000 0.2500 0.0000 -\nP 31 0.0000 0.0000 0.0000 0.0000 0.3125 0.0000 -\nP 32 0.0000 0.0000 0.0000 0.0000 0.3750 0.0000 -\nP 33 0.0000 0.0000 0.0000 0.0000 0.4375 0.0000 -\nP 34 0.0000 0.0000 0.0000 0.0000 0.5000 0.0000 -\nP 35 0.0000 0.0000 0.0000 0.0000 0.5625 0.0000 -\nP 36 0.0000 0.0000 0.0000 0.0000 0.6250 0.0000 -\nP 37 0.0000 0.0000 0.0000 0.0000 0.5625 0.0000 -\nP 38 0.0000 0.0000 0.0000 0.0000 0.5000 0.0000 -\nP 39 0.0000 0.0000 0.0000 0.0000 0.4375 0.0000 -\nP 40 0.0000 0.0000 0.0000 0.0000 0.3750 0.0000 -\nP 41 0.0000 0.0000 0.0000 0.0000 0.3125 0.0000 -\nP 42 0.0000 0.0000 0.0000 0.0000 0.2500 0.0000 -\nP 43 0.0000 0.0000 0.0000 0.0000 0.1875 0.0000 -\nP 44 0.0000 0.0000 0.0000 0.0000 0.1250 0.0000 -\nP 45 0.0000 0.0000 0.0000 0.0000 0.0625 0.0000 -\nP 46 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 47 6.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 48 12.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 49 18.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 50 24.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 51 24.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 52 24.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 53 18.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 54 12.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 55 6.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 56 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 57 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 58 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 59 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 60 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 61 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 62 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 63 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 64 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 65 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 66 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 67 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 68 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 69 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 70 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 71 0.0000 0.0000 1.0000 0.0000 0.0000 0.0000 -\nP 72 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 73 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 74 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -\nP 75 0.0000 0.0000 0.0000 0.0000 0.0000 0.0000 -",
};

// .cc_ap1_g2.lua (Brian's g2_pret / g1_pret under luajit)
const LUA_G2 = {
  s16: "-1 4464 25536 65531 255 -56",
  div: "-3 -1 -960 -128 -3",
  trig: "24 -3 -8 11548 36991",
  g1: "-1 4464 -3 -1 24 -3 -8 2687",
  arc: "14,-14 29,-27 44,-37 59,-42 74,-44 89,-43 103,-41 D103,-41 D103,-41",
  speed: "-0,-0,2047 -0,-0,2046 -0,-0,2045 -0,-0,2044",
  anim: "0/256/-0/0/256 0/264/-66/60/240 4/257/-137/113/211 0/233/-211/157/173 0/189/-283/188/126 4/125/-350/208/74 0/40/-407/213/21 0/-66/-450/207/-30 4/-195/-473/188/-78 8/-348/-469/159/-118 0/-527/-432/123/-150 0/-740/-350/81/-171",
  taskaff: "true:1,248,268,4 true:1,240,280,8 true:2,232,292,12 true:0,232,292,12 true:1,248,268,4 true:1,240,280,8 true:2,232,292,12 true:0,232,292,12 true:1,248,268,4 true:1,240,280,8 true:2,232,292,12 true:3,232,292,12 true:3,236,288,12 true:4,240,284,12",
};

/** -0 and 0 print differently in Lua; they are the same value. */
const n0 = (v: number): number => v + 0;
const nums = (s: string): number[] => s.split(/[\s,/:]+/).filter((x) => x !== "" && x !== "D").map((x) => n0(Number(x)));

let G3Lazy: any, Anim: any, AnimSprites: any, AnimTasks: any, AnimCallbacks: any, NotPortedError: any;
let P1: any, S1: any, K1: any, P2: any, T1: any, C1: any;

function runMove(id: number, onFrame?: (f: number) => void): { frames: number; ended: boolean; maxSprites: number } {
  try {
    Anim.reset({});
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
  }
  Anim.present(0).visible = true;
  Anim.present(1).visible = true;
  const vm = Anim.vm();
  let ended = false;
  Anim.launchMove(id, { attackerSide: "player", targetSide: "enemy", attackerId: 0, targetId: 1, onEnd: () => { ended = true; } });
  let frames = 0, maxSprites = 0;
  while (vm.active && frames < 5000) {
    vm.update(1 / 60);
    frames++;
    maxSprites = Math.max(maxSprites, AnimSprites.activeCount());
    if (onFrame) onFrame(frames);
  }
  return { frames, ended, maxSprites };
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: anim_port group 1 (g1_*, g2_pret)", () => {
  beforeAll(async () => {
    setHost(new DesktopHost(ROOT));
    ({ G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts"));
    ({ NotPortedError } = await import("../voxelmon/game/gen3/notported.ts"));
    ({ Anim } = await import("../voxelmon/game/gen3/core/battle/anim.ts"));
    ({ AnimSprites } = await import("../voxelmon/game/gen3/core/battle/anim_sprites.ts"));
    ({ AnimTasks } = await import("../voxelmon/game/gen3/core/battle/anim_tasks.ts"));
    ({ AnimCallbacks } = await import("../voxelmon/game/gen3/core/battle/anim_callbacks.ts"));
    ({ P: P1 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g1_pret.ts"));
    ({ S: S1 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g1_sprite.ts"));
    ({ K: K1 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g1_task_base.ts"));
    ({ P: P2 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g2_pret.ts"));
    ({ loadG1Tasks: T1 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g1_tasks.ts"));
    ({ loadG1Callbacks: C1 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g1_callbacks.ts"));
    // Only the g1 groups: the oracle's g1only mode (see the header).
    for (const k of Object.keys(G3Lazy)) {
      if (k.includes(".anim_port.") && !k.includes(".anim_port.g1_")) delete G3Lazy[k];
    }
  });

  test("g1 registers its two entry modules in G3Lazy as loaders", () => {
    const tasks = G3Lazy["src.core.game3.battle.anim_port.g1_tasks"];
    const cbs = G3Lazy["src.core.game3.battle.anim_port.g1_callbacks"];
    expect(typeof tasks).toBe("function");
    expect(typeof cbs).toBe("function");
    const T = tasks(AnimTasks);
    const C = cbs(AnimCallbacks);
    expect(T).toBe(T1());
    expect(C).toBe(C1());
    expect(typeof T.ShakeMon).toBe("function");
    expect(T._noGfx_BowMon).toBe(T.BowMon);
    expect(T._noGfx_DoHorizontalLunge).toBe(T.HorizontalLunge);
    expect(typeof C.HitSplatBasic).toBe("function");
    expect(typeof C.TauntFinger).toBe("function"); // part B
    // S.wrap remembers the init function (g1_tasks looks SolarBeamSmallOrb up)
    expect(typeof S1.inits.get(C.SolarBeamSmallOrb)).toBe("function");
    // the core merges them by name
    AnimTasks.init();
    expect(AnimTasks.REGISTRY.BlendColorCycle).toBe(T.BlendColorCycle);
    expect(AnimCallbacks.get("HitSplatBasic")).toBe(C.HitSplatBasic);
  });

  test("g1_pret / g2_pret math matches Brian's", () => {
    expect([P2.s16(-1), P2.s16(70000), P2.s16(-40000), P2.u16(-5), P2.u8(-1), P2.s8(200)]).toEqual(nums(LUA_G2.s16));
    expect([P2.div(-7, 2), P2.mod(-7, 2), P2.Q88mul(384, -640), P2.Q88inv(-512), P2.asr(-5, 1)].map(n0)).toEqual(nums(LUA_G2.div));
    expect([P2.Sin(40, 30), P2.Cos(200, -14), P2.Sin(-3, 100), P2.ArcTan2Neg(10, -20), P2.ArcTan2Neg(-7, 3)].map(n0)).toEqual(nums(LUA_G2.trig));
    expect([P1.s16(-1), P1.s16(70000), P1.cdiv(-7, 2), P1.cmod(-7, 2), P1.Sin(40, 30), P1.Cos(200, -14), P1.Sin(-3, 100),
      P1.RGB(31, 19, 2)].map(n0)).toEqual(nums(LUA_G2.g1));
  });

  test("g2_pret translations, sprite anim / affine runners and the task affine runner match Brian's", () => {
    let s: any = { data: {}, x: 72, y: 80, x2: 0, y2: 0 };
    for (let i = 0; i <= 7; i++) s.data[i] = 0;
    s.data[0] = 7; s.data[2] = 176; s.data[4] = 40;
    P2.InitAnimArcTranslation(s);
    s.data[5] = -20;
    const arc: string[] = [];
    for (let i = 0; i < 9; i++) {
      const done = P2.TranslateAnimHorizontalArc(s);
      arc.push((done ? "D" : "") + n0(s.x2) + "," + n0(s.y2));
    }
    expect(arc.join(" ")).toBe(LUA_G2.arc);

    s = { data: {}, x: 10, y: 100, x2: 0, y2: 0 };
    for (let i = 0; i <= 7; i++) s.data[i] = 0;
    s.data[0] = 5; s.data[2] = -30; s.data[4] = 60; s.data[1] = s.x; s.data[3] = s.y;
    P2.InitAnimLinearTranslationWithSpeed(s);
    const sp: number[] = [];
    for (let i = 0; i < 4; i++) { P2.AnimTranslateLinear(s); sp.push(s.x2, s.y2, s.data[0]); }
    expect(sp.map(n0)).toEqual(nums(LUA_G2.speed));

    const { A, AJ, F, J, L } = P2;
    s = {
      data: {}, affineMode: 1, animNum: 0,
      anims: [null, [null, F(0, 2), F(4, 1, true), L(2), F(8, 1), J(0)]],
      affine: [null, [null, A(256, 256, 0, 0), A(-16, 8, 10, 3), AJ(1)]],
    };
    P2.startAnim(s, 0); P2.startAffineAnim(s, 0);
    s.animPaused = false; s.affineAnimPaused = false;
    const an: number[] = [];
    for (let i = 0; i < 12; i++) { P2.animateSprite(s); an.push(s.tileNum, s.matA, s.matB, s.matC, s.matD); }
    expect(an.map(n0)).toEqual(nums(LUA_G2.anim));

    const t: any = { data: {}, g2: {} };
    for (let i = 0; i <= 15; i++) t.data[i] = 0;
    P2.PrepareAffineAnimInTaskData(t, null, [null, A(0x100, 0x100, 0, 0), A(-8, 12, 4, 3), L(2), A(4, -4, 0, 2), P2.AEND]);
    const ta: string[] = [];
    for (let i = 0; i < 14; i++) {
      const r = P2.RunAffineAnimFromTaskData(t);
      ta.push(r + ":" + [t.data[7], t.data[10], t.data[11], t.data[12]].join(","));
    }
    expect(ta.join(" ")).toBe(LUA_G2.taskaff);
  });

  test("K.wrap: pret task args from the spawn data, data cleared", () => {
    let seen: any = null;
    const fn = K1.wrap((t: any) => { seen = [...t._A]; t._fn = () => { seen = "step"; }; });
    const t: any = { data: { 0: "ANIM_TARGET", 1: -3, 2: 70000, 3: "attacker", 4: 5 } };
    for (let i = 5; i <= 15; i++) t.data[i] = 0;
    fn(t, null);
    expect(seen).toEqual([1, -3, 4464, 0, 5, 0, 0, 0]);
    expect(t.data[2]).toBe(0);
    fn(t, null);
    expect(seen).toBe("step");
  });

  test("TACKLE runs in Brian's 25 frames with the g1 groups (29 without anim_port)", () => {
    const r = runMove(TACKLE);
    expect(r.ended).toBe(true);
    expect(r.frames).toBe(ORACLE_G1[TACKLE]![0]);
    expect(r.frames).toBe(25);
    expect(ORACLE_NOPORT[TACKLE]).toBe(29);
  });

  test("every move (1..354): frames and peak sprites match Brian's VM with the g1 groups", () => {
    const bad: string[] = [];
    for (let id = 1; id <= 354; id++) {
      if (RANDOM_MOVES.has(id)) continue;
      const r = runMove(id);
      const [f, m] = ORACLE_G1[id]!;
      if (r.frames !== f || r.maxSprites !== m || !r.ended) bad.push(`${id}: ${r.frames}/${r.maxSprites} want ${f}/${m}`);
    }
    expect(bad).toEqual([]);
  }, 600000);

  test("the moves g1 completes reach Brian's full anim_port frame counts", () => {
    expect(G1_COMPLETE.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const id of G1_COMPLETE) {
      const r = runMove(id);
      if (r.frames !== ORACLE_FULL[id]) bad.push(`${id}: ${r.frames} want ${ORACLE_FULL[id]} (noport ${ORACLE_NOPORT[id]})`);
    }
    expect(bad).toEqual([]);
  }, 600000);

  test("sprite positions at a frame match Brian's (Sing, Conversion, Razor Leaf, Giga Drain)", () => {
    const norm = (l: string) => l.replace(/=-0(?![\d.])/g, "=0");
    for (const [key, want] of Object.entries(SPRITE_DUMPS)) {
      const [id, frame] = key.split(":").map(Number);
      const got: string[] = [];
      runMove(id!, (f) => {
        if (f !== frame) return;
        AnimSprites.forEachActive((s: any) => got.push(`S ${s.tag} x=${n0(s.x)} y=${n0(s.y)} ox=${n0(s.ox)} oy=${n0(s.oy)}`));
      });
      expect(got.map(norm).sort()).toEqual(want.split("\n").map(norm).sort());
    }
  }, 120000);

  test("mon offsets, mon blends and the bg blend per frame match Brian's (TACKLE, FLASH, RAGE)", () => {
    const v = (x: unknown) => format("%.4f", n0(Number(x ?? 0) || 0));
    for (const [id, want] of Object.entries(PRESENT_DUMPS)) {
      const got: string[] = [];
      runMove(Number(id), (f) => {
        const p0 = Anim.present(0), p1 = Anim.present(1), bb = Anim._bgBlend;
        got.push(`P ${f} ${v(p0.ox)} ${v(p0.oy)} ${v(p1.ox)} ${v(p1.oy)} ${v(p0.blendCoeff)} ${v(p1.blendCoeff)} ${bb ? bb.coeff + ":" + bb.color : "-"}`);
      });
      expect(got).toEqual(want.split("\n").map((l) => l.replace(/ -0\.0000/g, " 0.0000")));
    }
  }, 120000);
});
