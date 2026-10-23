//! Installing a received save: checked as data, the right game, the old
//! save kept, the new one written so a failure part-way never leaves a
//! half-written save in its place.
//!
//! 1. [`luadata::check`]: the bytes parse as a save and nothing more.
//! 2. Its `version` is this game's ([`accepts`]).
//! 3. The save being replaced is copied into the backup folder, read back,
//!    and the folder trimmed to the newest [`KEEP_BACKUPS`].
//! 4. The new bytes go to `<save>.tmp` and are read back; the old save is
//!    kept as `<save>.bak`; the temp file is renamed over the save.
//!
//! The steps run against [`Store`], so the whole path runs in host tests;
//! [`StdStore`] is std::fs (the 3DS's `sdmc:` and a desktop's disk alike).

use crate::luadata::{self, SaveInfo};
use crate::proto::MAX_SAVE;

/// How many replaced saves the backup folder keeps per save file.
pub const KEEP_BACKUPS: usize = 10;

/// The files the install touches.
pub trait Store {
    /// The file's bytes, or None when it does not exist (or cannot be read).
    fn read(&mut self, path: &str) -> Option<Vec<u8>>;
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
    /// Rename; may fail when `to` exists (the 3DS's FAT does).
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    fn remove(&mut self, path: &str);
    /// File names (not paths) in `dir`; empty when it does not exist.
    fn list(&mut self, dir: &str) -> Vec<String>;
    fn mkdir(&mut self, dir: &str);
}

/// std::fs.
pub struct StdStore;

impl Store for StdStore {
    fn read(&mut self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        std::fs::write(path, data).map_err(|e| format!("{}", e))
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        std::fs::rename(from, to).map_err(|e| format!("{}", e))
    }
    fn remove(&mut self, path: &str) {
        let _ = std::fs::remove_file(path);
    }
    fn list(&mut self, dir: &str) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }
    fn mkdir(&mut self, dir: &str) {
        let _ = std::fs::create_dir_all(dir);
    }
}

/// Why a received save was not installed. `reason()` is the status line's
/// text after `REFUSED: ` / `ERROR: `.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Empty, or over [`MAX_SAVE`].
    Size(usize),
    /// Not a save (the parser's message, for the log).
    NotASave(String),
    /// A save of another game (its `version`, or None when it has none).
    WrongGame(Option<String>),
    /// The card would not take the backup or the write.
    Disk(String),
}

impl Refusal {
    pub fn reason(&self) -> String {
        match self {
            Refusal::Size(0) => "EMPTY SAVE".into(),
            Refusal::Size(_) => "SAVE TOO BIG".into(),
            Refusal::NotASave(_) => "NOT A SAVE".into(),
            Refusal::WrongGame(Some(v)) => format!("SAVE IS {}", crate::proto::sanitize_name(v)),
            Refusal::WrongGame(None) => "SAVE HAS NO GAME".into(),
            Refusal::Disk(_) => "SD CARD WRITE FAILED".into(),
        }
    }
    /// Whether this is the card's fault (ERROR) rather than the save's (REFUSED).
    pub fn is_error(&self) -> bool {
        matches!(self, Refusal::Disk(_))
    }
}

/// Whether a save whose `version` is `version` belongs on `local_game`.
///
/// The same game only -- with one exception: this port's Blue has always
/// written `version = "red"` into its own saves (the two share one save
/// format), so Blue also takes a save tagged red. A red peer still never
/// reaches Blue's install: discovery shows it as another game and offers
/// no GET.
pub fn accepts(local_game: &str, version: &str) -> bool {
    version == local_game || (local_game == "blue" && version == "red")
}

/// Where a save lives and where its replaced copies go.
#[derive(Clone, Debug)]
pub struct Paths {
    /// e.g. `sdmc:/3ds/voxelmon/save_blue.lua`
    pub save: String,
    /// e.g. `sdmc:/3ds/voxelmon/sync_backups`
    pub backups: String,
}

impl Paths {
    fn stem(&self) -> &str {
        let file = self.save.rsplit('/').next().unwrap_or("save.lua");
        file.strip_suffix(".lua").unwrap_or(file)
    }
}

/// The backup files of `stem` in `names`, as (sequence, name), oldest first.
fn backups_of(stem: &str, names: &[String]) -> Vec<(u64, String)> {
    let prefix = format!("{}_", stem);
    let mut out: Vec<(u64, String)> = names
        .iter()
        .filter_map(|n| {
            let rest = n.strip_prefix(&prefix)?;
            if !n.ends_with(".lua") || rest.len() < 6 || !rest.as_bytes()[..6].iter().all(|c| c.is_ascii_digit()) {
                return None;
            }
            // the six digits end at `_` (the stamp) or at `.lua`
            let after = &rest[6..];
            if !(after.starts_with('_') || after == ".lua") {
                return None;
            }
            Some((rest[..6].parse().ok()?, n.clone()))
        })
        .collect();
    out.sort();
    out
}

/// Copy `old` into the backup folder as `<stem>_<seq>_<stamp>.lua`, read it
/// back, and drop the oldest beyond [`KEEP_BACKUPS`]. Returns the path.
pub fn keep_backup(store: &mut dyn Store, paths: &Paths, old: &[u8], stamp: &str) -> Result<String, String> {
    store.mkdir(&paths.backups);
    let stem = paths.stem().to_string();
    let have = backups_of(&stem, &store.list(&paths.backups));
    let seq = have.last().map(|(s, _)| s + 1).unwrap_or(1) % 1_000_000;
    let stamp: String = stamp.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let name = if stamp.is_empty() { format!("{}_{:06}.lua", stem, seq) } else { format!("{}_{:06}_{}.lua", stem, seq, stamp) };
    let path = format!("{}/{}", paths.backups, name);
    store.write(&path, old)?;
    match store.read(&path) {
        Some(back) if back == old => {}
        Some(back) => return Err(format!("{} read back {} of {} bytes", path, back.len(), old.len())),
        None => return Err(format!("{} did not read back", path)),
    }
    let mut mine = backups_of(&stem, &store.list(&paths.backups));
    while mine.len() > KEEP_BACKUPS {
        let (_, old_name) = mine.remove(0);
        store.remove(&format!("{}/{}", paths.backups, old_name));
    }
    Ok(path)
}

/// Write `body` over the save: `.tmp` written and read back, the old save
/// kept as `.bak`, the temp renamed into place.
pub fn write_atomic(store: &mut dyn Store, save: &str, body: &[u8]) -> Result<(), String> {
    let tmp = format!("{}.tmp", save);
    let bak = format!("{}.bak", save);
    store.remove(&tmp);
    store.write(&tmp, body)?;
    if store.read(&tmp).as_deref() != Some(body) {
        store.remove(&tmp);
        return Err(format!("{} did not read back", tmp));
    }
    let old = store.read(save);
    if let Some(old) = &old {
        store.write(&bak, old)?;
        if store.read(&bak).as_deref() != Some(&old[..]) {
            store.remove(&tmp);
            return Err(format!("{} did not read back", bak));
        }
    }
    if store.rename(&tmp, save).is_err() {
        // FAT will not rename over an existing file: clear it first (the
        // old bytes are in .bak and in the backup folder by now)
        store.remove(save);
        if let Err(e) = store.rename(&tmp, save) {
            if let Some(old) = &old {
                let _ = store.write(save, old);
            }
            store.remove(&tmp);
            return Err(format!("rename {} -> {}: {}", tmp, save, e));
        }
    }
    if store.read(save).as_deref() != Some(body) {
        return Err(format!("{} did not read back", save));
    }
    Ok(())
}

/// The whole install (see the module notes). `stamp` names the backup
/// (`YYYYMMDD-HHMMSS`, or empty without a clock). Ok with what the save
/// says about itself.
pub fn install(store: &mut dyn Store, paths: &Paths, body: &[u8], local_game: &str, stamp: &str) -> Result<SaveInfo, Refusal> {
    if body.is_empty() || body.len() > MAX_SAVE {
        return Err(Refusal::Size(body.len()));
    }
    let info = luadata::check(body).map_err(Refusal::NotASave)?;
    match info.version.as_deref() {
        Some(v) if accepts(local_game, v) => {}
        other => return Err(Refusal::WrongGame(other.map(|s| s.to_string()))),
    }
    if let Some(old) = store.read(&paths.save) {
        if !old.is_empty() {
            keep_backup(store, paths, &old, stamp).map_err(Refusal::Disk)?;
        }
    }
    write_atomic(store, &paths.save, body).map_err(Refusal::Disk)?;
    Ok(info)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A card in memory; `fat` makes rename refuse an existing target, and
    /// `fail_write` makes writes to paths containing it fail.
    #[derive(Default)]
    pub struct MemStore {
        pub files: BTreeMap<String, Vec<u8>>,
        pub fat: bool,
        pub fail_write: Option<String>,
    }

    impl Store for MemStore {
        fn read(&mut self, path: &str) -> Option<Vec<u8>> {
            self.files.get(path).cloned()
        }
        fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
            if let Some(f) = &self.fail_write {
                if path.contains(f.as_str()) {
                    return Err("card is write-protected".into());
                }
            }
            self.files.insert(path.to_string(), data.to_vec());
            Ok(())
        }
        fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
            if self.fat && self.files.contains_key(to) {
                return Err("exists".into());
            }
            let v = self.files.remove(from).ok_or("no such file")?;
            self.files.insert(to.to_string(), v);
            Ok(())
        }
        fn remove(&mut self, path: &str) {
            self.files.remove(path);
        }
        fn list(&mut self, dir: &str) -> Vec<String> {
            let p = format!("{}/", dir);
            self.files.keys().filter_map(|k| k.strip_prefix(&p)).filter(|k| !k.contains('/')).map(|k| k.to_string()).collect()
        }
        fn mkdir(&mut self, _dir: &str) {}
    }

    fn paths() -> Paths {
        Paths { save: "sd/save_blue.lua".into(), backups: "sd/sync_backups".into() }
    }

    fn save(version: &str, name: &str) -> Vec<u8> {
        format!("return {{\n  player = {{\n    name = \"{}\",\n  }},\n  version = \"{}\",\n}}\n", name, version).into_bytes()
    }

    #[test]
    fn a_valid_save_is_installed_and_the_old_one_kept() {
        for fat in [false, true] {
            let mut st = MemStore { fat, ..Default::default() };
            let old = save("blue", "OLD");
            st.files.insert(paths().save, old.clone());
            let new = save("blue", "NEW");
            let info = install(&mut st, &paths(), &new, "blue", "20261022-120000").unwrap();
            assert_eq!(info.player_name.as_deref(), Some("NEW"));
            assert_eq!(st.files.get("sd/save_blue.lua"), Some(&new));
            assert_eq!(st.files.get("sd/save_blue.lua.bak"), Some(&old));
            assert!(!st.files.contains_key("sd/save_blue.lua.tmp"));
            assert_eq!(st.files.get("sd/sync_backups/save_blue_000001_20261022-120000.lua"), Some(&old));
        }
    }

    #[test]
    fn no_old_save_means_no_backup() {
        let mut st = MemStore::default();
        install(&mut st, &paths(), &save("blue", "A"), "blue", "").unwrap();
        assert_eq!(st.list("sd/sync_backups").len(), 0);
        assert!(!st.files.contains_key("sd/save_blue.lua.bak"));
    }

    #[test]
    fn wrong_game_is_refused_and_nothing_is_touched() {
        let mut st = MemStore::default();
        let old = save("blue", "OLD");
        st.files.insert(paths().save, old.clone());
        let r = install(&mut st, &paths(), &save("gold", "X"), "blue", "s");
        assert_eq!(r, Err(Refusal::WrongGame(Some("gold".into()))));
        assert_eq!(r.unwrap_err().reason(), "SAVE IS GOLD");
        let r = install(&mut st, &paths(), b"return { player = { name = \"X\" } }", "blue", "s");
        assert_eq!(r.unwrap_err().reason(), "SAVE HAS NO GAME");
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files.get("sd/save_blue.lua"), Some(&old));
    }

    #[test]
    fn version_rules() {
        assert!(accepts("red", "red"));
        assert!(!accepts("red", "blue"));
        assert!(accepts("blue", "blue"));
        assert!(accepts("blue", "red"));
        assert!(accepts("yellow", "yellow"));
        assert!(!accepts("yellow", "red"));
        assert!(accepts("crystal", "crystal"));
        assert!(!accepts("crystal", "gold"));
        assert!(!accepts("silver", "gold"));
    }

    #[test]
    fn malformed_and_code_are_refused() {
        let mut st = MemStore::default();
        st.files.insert(paths().save, save("blue", "OLD"));
        for bad in [
            &b"not a save"[..],
            b"return { version = \"blue\"",
            b"return { version = \"blue\" } os.execute(\"x\")",
            b"return { version = \"blue\", f = load(\"x\") }",
            b"return dofile(\"sdmc:/x.lua\")",
        ] {
            let r = install(&mut st, &paths(), bad, "blue", "s");
            assert!(matches!(r, Err(Refusal::NotASave(_))), "{:?}", String::from_utf8_lossy(bad));
            assert_eq!(r.unwrap_err().reason(), "NOT A SAVE");
        }
        assert_eq!(install(&mut st, &paths(), b"", "blue", "s").unwrap_err().reason(), "EMPTY SAVE");
        let big = vec![b' '; MAX_SAVE + 1];
        assert_eq!(install(&mut st, &paths(), &big, "blue", "s").unwrap_err().reason(), "SAVE TOO BIG");
        assert_eq!(st.files.len(), 1, "a refused save writes nothing");
    }

    #[test]
    fn the_backup_ring_keeps_ten() {
        let mut st = MemStore::default();
        // another game's backups in the same folder are not this one's
        st.files.insert("sd/sync_backups/save_000001_x.lua".into(), b"red's".to_vec());
        st.files.insert("sd/sync_backups/save_blue_notes.txt".into(), b"?".to_vec());
        for i in 0..25 {
            let s = save("blue", &format!("P{}", i));
            install(&mut st, &paths(), &s, "blue", &format!("2026102{}-0000{:02}", i % 10, i)).unwrap();
        }
        let mine: Vec<String> = backups_of("save_blue", &st.list("sd/sync_backups")).into_iter().map(|(_, n)| n).collect();
        assert_eq!(mine.len(), KEEP_BACKUPS);
        // 24 replaced saves (P0..P23), numbered 1..24; the newest ten stay
        assert!(mine[0].starts_with("save_blue_000015_"), "{:?}", mine);
        assert!(mine[9].starts_with("save_blue_000024_"), "{:?}", mine);
        assert_eq!(st.files.get(&format!("sd/sync_backups/{}", mine[9])), Some(&save("blue", "P23")));
        assert!(st.files.contains_key("sd/sync_backups/save_000001_x.lua"));
        assert!(st.files.contains_key("sd/sync_backups/save_blue_notes.txt"));
    }

    #[test]
    fn a_failed_write_leaves_the_old_save() {
        let mut st = MemStore { fat: true, fail_write: Some(".tmp".into()), ..Default::default() };
        let old = save("blue", "OLD");
        st.files.insert(paths().save, old.clone());
        let r = install(&mut st, &paths(), &save("blue", "NEW"), "blue", "s");
        assert!(matches!(r, Err(Refusal::Disk(_))));
        assert!(r.unwrap_err().is_error());
        assert_eq!(st.files.get("sd/save_blue.lua"), Some(&old));

        // the backup folder unwritable: refused before the save is touched
        let mut st = MemStore { fail_write: Some("sync_backups".into()), ..Default::default() };
        st.files.insert(paths().save, old.clone());
        assert!(matches!(install(&mut st, &paths(), &save("blue", "NEW"), "blue", "s"), Err(Refusal::Disk(_))));
        assert_eq!(st.files.get("sd/save_blue.lua"), Some(&old));
    }

    #[test]
    fn std_store_round_trip() {
        let dir = std::env::temp_dir().join(format!("pvsync-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = Paths {
            save: dir.join("save_yellow.lua").to_string_lossy().into_owned(),
            backups: dir.join("sync_backups").to_string_lossy().into_owned(),
        };
        let mut st = StdStore;
        std::fs::write(&p.save, save("yellow", "OLD")).unwrap();
        install(&mut st, &p, &save("yellow", "NEW"), "yellow", "20261022-000000").unwrap();
        assert_eq!(std::fs::read(&p.save).unwrap(), save("yellow", "NEW"));
        assert_eq!(std::fs::read(format!("{}.bak", p.save)).unwrap(), save("yellow", "OLD"));
        assert_eq!(st.list(&p.backups).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
