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
        for n in ["g3_png.c", "g3_files.c", "g3_render.c", "g3_shim.c", "g3_world.c"] {
            println!("cargo:rerun-if-changed=src/gen3/{n}");
            g.file(format!("src/gen3/{n}"));
        }
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
            std::fs::copy("game-firered.qbc", out.join("g3.qbc")).unwrap();
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
