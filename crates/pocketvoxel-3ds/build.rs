fn main() {
    let dkp = std::env::var("DEVKITPRO").unwrap_or_else(|_| "/opt/devkitpro".into());
    let skip = ["qjs.c","qjsc.c","quickjs-libc.c","run-test262.c",
                "api-test.c","ctest.c","lre-test.c","unicode_gen.c","qjs-wasi-reactor.c"];
    let mut b = cc::Build::new();
    b.compiler(format!("{dkp}/devkitARM/bin/arm-none-eabi-gcc"))
        .archiver(format!("{dkp}/devkitARM/bin/arm-none-eabi-ar"))
        .include("vendor/quickjs")
        .include(format!("{dkp}/libctru/include"))
        .include(format!("{dkp}/portlibs/3ds/include"))
        .flag("-march=armv6k").flag("-mtune=mpcore")
        .flag("-mfloat-abi=hard").flag("-mtp=soft")
        .flag("-Wno-incompatible-pointer-types")
        .flag("-Wno-implicit-function-declaration")
        // devkitARM's newlib types int32_t as `long int`. QuickJS passes
        // `int*` where it declared `int32_t*`; with 4-byte longs the sizes
        // are the same width, but the mismatch is what the pointer warnings
        // were about. Keep sizes explicit and signed-correct.
        .flag("-fno-strict-aliasing")
        .flag("-fwrapv")
        // devkitARM's newlib types int32_t as `long int`. QuickJS passes
        // `int*` where it declared `int32_t*`; with 4-byte longs the sizes
        // are the same width, but the mismatch is what the pointer warnings
        // were about. Keep sizes explicit and signed-correct.
        .flag("-fno-strict-aliasing")
        .flag("-fwrapv")
        // devkitARM's newlib types int32_t as `long int`. QuickJS passes
        // `int*` where it declared `int32_t*`; with 4-byte longs the sizes
        // are the same width, but the mismatch is what the pointer warnings
        // were about. Keep sizes explicit and signed-correct.
        .flag("-fno-strict-aliasing")
        .flag("-fwrapv")
        .define("__3DS__", None).define("ARM11", None)
        .define("_GNU_SOURCE", None).define("CONFIG_VERSION", "\"3ds\"")
        // No pthreads: skips <pthread.h> and CONFIG_ATOMICS, so QuickJS
        // never collides with pthread-3ds.
        .define("__DJGPP", None)
        .opt_level(2).warnings(false);
    for e in std::fs::read_dir("vendor/quickjs").unwrap() {
        let p = e.unwrap().path();
        if p.extension().and_then(|s| s.to_str()) != Some("c") { continue; }
        let n = p.file_name().unwrap().to_str().unwrap().to_string();
        if skip.contains(&n.as_str()) || n.starts_with("fuzz") { continue; }
        println!("cargo:rerun-if-changed=vendor/quickjs/{n}");
        b.file(&p);
    }
    // FireRed: QuickJS counts its heap by newlib's chunk sizes (cutils.h
    // js__malloc_usable_size); the MIT games' QuickJS is built as before
    if std::env::var_os("CARGO_FEATURE_GEN3").is_some() {
        b.define("PV_QJS_USABLE_SIZE", None);
    }
    b.compile("quickjs");
    // The FireRed host (src/gen3/*.c: the Gen 3 display and natives, GPLv3 +
    // additional terms), only for the gen3 builds.
    if std::env::var_os("CARGO_FEATURE_GEN3").is_some() {
        let mut g = cc::Build::new();
        g.compiler(format!("{dkp}/devkitARM/bin/arm-none-eabi-gcc"))
            .archiver(format!("{dkp}/devkitARM/bin/arm-none-eabi-ar"))
            .include("vendor/quickjs")
            .include(format!("{dkp}/libctru/include"))
            .include(format!("{dkp}/portlibs/3ds/include"))
            .flag("-march=armv6k").flag("-mtune=mpcore")
            .flag("-mfloat-abi=hard").flag("-mtp=soft")
            .flag("-fno-strict-aliasing")
            .define("__3DS__", None).define("ARM11", None)
            .opt_level(2).warnings(false);
        for n in ["g3_png.c", "g3_files.c", "g3_render.c", "g3_shim.c", "g3_world.c", "g3_save.c", "g3_heap.c"] {
            println!("cargo:rerun-if-changed=src/gen3/{n}");
            g.file(format!("src/gen3/{n}"));
        }
        // (included by g3_shim.c, and by the desktop runner tools/gen3/qjs_run.c)
        println!("cargo:rerun-if-changed=src/gen3/g3_fast.c");
        g.compile("pvgen3");
        // The guest's boot: QuickJS bytecode when cc_build_firered.sh made a
        // game-firered.qbc at least as new as the bundle (main.rs then runs a
        // one-line stub that loads it, src/gen3/mod.rs), else the bundle's
        // source as before.
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
        println!("cargo:rerun-if-changed=game-firered.js");
        println!("cargo:rerun-if-changed=game-firered.qbc");
        let mtime = |p: &str| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let fresh = match (mtime("game-firered.qbc"), mtime("game-firered.js")) {
            (Some(q), Some(j)) => q >= j && std::fs::metadata("game-firered.qbc").map(|m| m.len() > 0).unwrap_or(false),
            _ => false,
        };
        if fresh {
            // Deflated ("PVQZ", the raw size as a u32 LE, a raw deflate
            // stream; g3_shim.c g3RunBytecode inflates it, reads it and lets
            // it go): the binary is the app's own memory for as long as it
            // runs, so 5.9 MB of bytecode needed once at boot took 5.9 MB from
            // the app heap for the whole session; deflated it is ~3. (The
            // deflate is this file's own, below: a crate for it changed the
            // dependency graph, and with it every game's binary.)
            let raw = std::fs::read("game-firered.qbc").unwrap();
            let mut z = b"PVQZ".to_vec();
            z.extend_from_slice(&(raw.len() as u32).to_le_bytes());
            z.extend_from_slice(&deflate_fixed(&raw));
            std::fs::write(out.join("g3.qbc"), z).unwrap();
            std::fs::write(out.join("g3_boot.js"), "voxel.g3RunBytecode();\n").unwrap();
        } else {
            if mtime("game-firered.qbc").is_some() {
                println!("cargo:warning=game-firered.qbc is older than game-firered.js: booting from the source");
            }
            std::fs::write(out.join("g3.qbc"), b"").unwrap();
            std::fs::copy("game-firered.js", out.join("g3_boot.js")).unwrap();
        }
    }
}

/// A raw deflate stream (RFC 1951) of one block with the fixed Huffman
/// codes, matches found greedily through 3-byte hash chains in a 32 KB
/// window: for FireRed's boot bytecode (any inflater reads it; the host's
/// is g3_png.c g3_inflate).
fn deflate_fixed(data: &[u8]) -> Vec<u8> {
    const LBASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const WIN: usize = 32768;
    const CHAIN: usize = 48;
    struct Bits { out: Vec<u8>, acc: u64, n: u32 }
    impl Bits {
        fn put(&mut self, v: u32, n: u32) {
            self.acc |= (v as u64) << self.n;
            self.n += n;
            while self.n >= 8 { self.out.push(self.acc as u8); self.acc >>= 8; self.n -= 8; }
        }
        /// a Huffman code, most significant bit first
        fn code(&mut self, c: u32, n: u32) {
            let mut r = 0u32;
            for i in 0..n { r |= ((c >> i) & 1) << (n - 1 - i); }
            self.put(r, n);
        }
        fn lit(&mut self, s: u32) {
            match s {
                0..=143 => self.code(0x30 + s, 8),
                144..=255 => self.code(0x190 + s - 144, 9),
                256..=279 => self.code(s - 256, 7),
                _ => self.code(0xC0 + s - 280, 8),
            }
        }
    }
    let mut b = Bits { out: Vec::with_capacity(data.len() / 2), acc: 0, n: 0 };
    b.put(1, 1); // the last block
    b.put(1, 2); // fixed codes
    let hash = |i: usize| -> usize { ((data[i] as usize) << 10 ^ (data[i + 1] as usize) << 5 ^ data[i + 2] as usize) & 0x7FFF };
    let mut head = vec![usize::MAX; 0x8000];
    let mut prev = vec![usize::MAX; WIN];
    let insert = |head: &mut Vec<usize>, prev: &mut Vec<usize>, i: usize| {
        if i + 2 < data.len() {
            let h = hash(i);
            prev[i % WIN] = head[h];
            head[h] = i;
        }
    };
    let mut i = 0;
    while i < data.len() {
        let (mut best, mut bdist) = (0usize, 0usize);
        if i + 2 < data.len() {
            let mut c = head[hash(i)];
            let mut tries = 0;
            let max = (data.len() - i).min(258);
            while c != usize::MAX && i - c <= WIN && tries < CHAIN {
                let mut l = 0;
                while l < max && data[c + l] == data[i + l] { l += 1; }
                if l > best { best = l; bdist = i - c; if l == max { break; } }
                let p = prev[c % WIN];
                if p == usize::MAX || p >= c { break; }
                c = p;
                tries += 1;
            }
        }
        if best >= 3 {
            let li = LBASE.iter().rposition(|&x| x as usize <= best).unwrap();
            b.lit(257 + li as u32);
            b.put((best - LBASE[li] as usize) as u32, LEXTRA[li] as u32);
            let di = DBASE.iter().rposition(|&x| x as usize <= bdist).unwrap();
            b.code(di as u32, 5);
            b.put((bdist - DBASE[di] as usize) as u32, DEXTRA[di] as u32);
            for k in 0..best { insert(&mut head, &mut prev, i + k); }
            i += best;
        } else {
            b.lit(data[i] as u32);
            insert(&mut head, &mut prev, i);
            i += 1;
        }
    }
    b.lit(256);
    if b.n > 0 { b.out.push(b.acc as u8); }
    b.out
}
