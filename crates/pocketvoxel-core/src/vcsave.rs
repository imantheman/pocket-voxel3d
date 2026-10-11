//! The 3DS re-releases (VC) of Red, Blue and Yellow keep the cartridge's
//! 32 KB battery save in their own save data. This finds that save, reads
//! it, and -- only when the player saved in that mode -- backs it up to the
//! SD card and writes the new one in, committing the archive after.
//!
//! The file system is behind [`VcFs`] (the console's title list and one
//! title's save archive) and [`Card`] (the SD card), so all of the logic
//! here runs, and is tested, on a desktop with a fake; the 3DS host supplies
//! the real thing (libctru's AM and FS calls).
//!
//! Safety rules, all enforced here:
//!   - nothing is written unless asked ([`write_save`] is the only writer);
//!   - before every write the save as it is in the archive now is copied to
//!     `<backup dir>/<game>_<date>-<time>.sav`, read back, and only then is
//!     the archive touched; the last [`KEEP_BACKUPS`] per game are kept;
//!   - the new save is read back from the archive before the commit; a
//!     save archive is journalled, so nothing is final until the commit and
//!     a write that fails part way leaves the old save in place;
//!   - bytes after the first 32 KB of the file (if a title keeps any) are
//!     written back exactly as they were.

#![cfg(feature = "std")]

use std::string::String;
use std::vec::Vec;
use std::format;

/// The cartridge save: four 8 KB banks.
pub const SRAM_SIZE: usize = 0x8000;
/// Backups kept per game.
pub const KEEP_BACKUPS: usize = 10;

/// Which game this build is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Game {
    Red,
    Blue,
    Yellow,
}

impl Game {
    pub fn name(self) -> &'static str {
        match self {
            Game::Red => "red",
            Game::Blue => "blue",
            Game::Yellow => "yellow",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Game::Red => "Red",
            Game::Blue => "Blue",
            Game::Yellow => "Yellow",
        }
    }
    /// The US titles' IDs (the eShop listings' program IDs).
    pub fn us_title(self) -> u64 {
        match self {
            Game::Red => 0x0004_0000_0017_1000,
            Game::Blue => 0x0004_0000_0017_1100,
            Game::Yellow => 0x0004_0000_0017_1200,
        }
    }
}

/// A title ID in the block the three re-releases sit in, for the log: if
/// the console has one of these and it is not the expected ID, the log
/// says so, and `vc_titles.txt` can name it.
pub fn looks_like_vc_title(tid: u64) -> bool {
    (0x0004_0000_0017_0000..=0x0004_0000_0017_2fff).contains(&tid)
}

/// `vc_titles.txt` on the card: lines `red=0004000000171000` (hex) naming
/// a title to use instead of the US one. Anything else is ignored.
pub fn title_override(text: &str, game: Game) -> Option<u64> {
    for line in text.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once('=') {
            if k.trim().eq_ignore_ascii_case(game.name()) {
                if let Ok(id) = u64::from_str_radix(v.trim().trim_start_matches("0x"), 16) {
                    return Some(id);
                }
            }
        }
    }
    None
}

/// The console's titles and one title's save archive.
pub trait VcFs {
    /// Installed titles on the SD card. Err when the list cannot be had
    /// (no access to the title manager); the known IDs are then tried as
    /// they are.
    fn titles(&mut self) -> Result<Vec<u64>, String>;
    /// Open `tid`'s save data. Err when it is not installed, has no save
    /// data, or this program may not open it.
    fn open(&mut self, tid: u64) -> Result<(), String>;
    /// The files in the open archive's root, with their sizes.
    fn files(&mut self) -> Result<Vec<(String, u64)>, String>;
    fn read(&mut self, name: &str) -> Result<Vec<u8>, String>;
    /// Overwrite `name` with `data` (same size: the file is never grown or
    /// cut).
    fn write(&mut self, name: &str, data: &[u8]) -> Result<(), String>;
    /// Make the writes final.
    fn commit(&mut self) -> Result<(), String>;
    fn close(&mut self);
}

/// The SD card, for the backups.
pub trait Card {
    fn list(&mut self, dir: &str) -> Vec<String>;
    fn mkdir(&mut self, dir: &str);
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String>;
    fn read(&mut self, path: &str) -> Result<Vec<u8>, String>;
    fn remove(&mut self, path: &str);
}

/// The card through std::fs (the 3DS's sdmc: and a desktop's disk alike).
pub struct StdCard;

impl Card for StdCard {
    fn list(&mut self, dir: &str) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|it| it.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default()
    }
    fn mkdir(&mut self, dir: &str) {
        let _ = std::fs::create_dir_all(dir);
    }
    fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
        std::fs::write(path, data).map_err(|e| format!("{}", e))
    }
    fn read(&mut self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(|e| format!("{}", e))
    }
    fn remove(&mut self, path: &str) {
        let _ = std::fs::remove_file(path);
    }
}

/// The game's checksum over the main data: the complement of the byte sum
/// of $2598..$3522, stored at $3523.
pub fn main_checksum_ok(sram: &[u8]) -> bool {
    if sram.len() < SRAM_SIZE {
        return false;
    }
    let sum = sram[0x2598..0x3523].iter().fold(0u8, |a, &b| a.wrapping_add(b));
    !sum == sram[0x3523]
}

/// What was found: the title, the save file, and the file as it is.
#[derive(Clone, Debug)]
pub struct Found {
    pub tid: u64,
    pub file: String,
    /// The whole file: the 32 KB save, then anything the title keeps after.
    pub raw: Vec<u8>,
}

impl Found {
    /// The cartridge save.
    pub fn sram(&self) -> &[u8] {
        &self.raw[..SRAM_SIZE]
    }
    /// Whether it holds a game (a save that has never been written is
    /// all $FF or zero and fails the checksum).
    pub fn has_game(&self) -> bool {
        main_checksum_ok(self.sram())
    }
}

/// The save file among the archive's files: `sav.dat` when it is there
/// (the name the cartridge titles use), else the first file big enough to
/// hold a cartridge save.
pub fn pick_file(files: &[(String, u64)]) -> Option<(String, u64)> {
    let big = |f: &&(String, u64)| f.1 >= SRAM_SIZE as u64;
    files
        .iter()
        .filter(big)
        .find(|f| f.0.trim_start_matches('/').eq_ignore_ascii_case("sav.dat"))
        .or_else(|| files.iter().filter(big).min_by_key(|f| (f.1, f.0.clone())))
        .cloned()
}

/// Find this game's title and read its save. Every step is logged; None
/// (with the reason logged) means the VC option stays hidden.
pub fn probe(fs: &mut dyn VcFs, game: Game, override_tid: Option<u64>, log: &mut dyn FnMut(&str)) -> Option<Found> {
    let want = override_tid.unwrap_or(game.us_title());
    if let Some(t) = override_tid {
        log(&format!("vc: vc_titles.txt names {:016x} for {}", t, game.label()));
    }
    match fs.titles() {
        Ok(list) => {
            let near: Vec<String> = list.iter().filter(|t| looks_like_vc_title(**t)).map(|t| format!("{:016x}", t)).collect();
            log(&format!("vc: {} titles on the card; in the VC block: [{}]", list.len(), near.join(", ")));
            if !list.contains(&want) {
                if override_tid.is_none() {
                    log(&format!("vc: no {} title ({:016x}) installed; VC saves off", game.label(), want));
                    return None;
                }
                // a title named in vc_titles.txt is tried even when the list
                // does not show it (the list can leave titles out)
                log(&format!("vc: {:016x} is not in the title list; trying it anyway (vc_titles.txt)", want));
            } else {
                log(&format!("vc: found {} title {:016x}", game.label(), want));
            }
        }
        Err(e) => log(&format!("vc: title list unavailable ({}); trying {:016x} directly", e, want)),
    }
    if let Err(e) = fs.open(want) {
        log(&format!("vc: cannot open the {} save data ({}); VC saves off", game.label(), e));
        return None;
    }
    let files = match fs.files() {
        Ok(f) => f,
        Err(e) => {
            log(&format!("vc: cannot list the save data ({}); VC saves off", e));
            fs.close();
            return None;
        }
    };
    let names: Vec<String> = files.iter().map(|(n, s)| format!("{} {}", n, s)).collect();
    log(&format!("vc: save data holds [{}]", names.join(", ")));
    let Some((file, size)) = pick_file(&files) else {
        log("vc: no file big enough for a cartridge save; VC saves off");
        fs.close();
        return None;
    };
    let raw = match fs.read(&file) {
        Ok(r) if r.len() as u64 == size && r.len() >= SRAM_SIZE => r,
        Ok(r) => {
            log(&format!("vc: {} read {} of {} bytes; VC saves off", file, r.len(), size));
            fs.close();
            return None;
        }
        Err(e) => {
            log(&format!("vc: cannot read {} ({}); VC saves off", file, e));
            fs.close();
            return None;
        }
    };
    fs.close();
    let found = Found { tid: want, file, raw };
    log(&format!(
        "vc: {} save {} bytes{}, {}",
        found.file,
        found.raw.len(),
        if found.raw.len() > SRAM_SIZE { format!(" ({} kept after the 32 KB)", found.raw.len() - SRAM_SIZE) } else { String::new() },
        if found.has_game() { "holds a game" } else { "empty (never saved)" }
    ));
    Some(found)
}

/// `YYYYMMDD-HHMMSS` from seconds since 1970 (the console's clock).
pub fn stamp(unix: u64) -> String {
    let days = (unix / 86400) as i64;
    let rem = unix % 86400;
    // civil from days (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", y, m, d, rem / 3600, rem / 60 % 60, rem % 60)
}

/// Copy `raw` to `<dir>/<game>_<stamp>.sav` (`_2`, `_3`... if that name is
/// taken), read it back, and drop the oldest beyond [`KEEP_BACKUPS`].
pub fn backup(card: &mut dyn Card, dir: &str, game: Game, when: &str, raw: &[u8]) -> Result<String, String> {
    card.mkdir(dir);
    let existing = card.list(dir);
    let mut name = format!("{}_{}.sav", game.name(), when);
    let mut n = 2;
    while existing.iter().any(|e| *e == name) {
        name = format!("{}_{}_{}.sav", game.name(), when, n);
        n += 1;
    }
    let path = format!("{}/{}", dir, name);
    card.write(&path, raw)?;
    match card.read(&path) {
        Ok(back) if back == raw => {}
        Ok(back) => return Err(format!("{} read back {} of {} bytes", path, back.len(), raw.len())),
        Err(e) => return Err(format!("{} did not read back: {}", path, e)),
    }
    let prefix = format!("{}_", game.name());
    let mut mine: Vec<String> = card.list(dir).into_iter().filter(|f| f.starts_with(&prefix) && f.ends_with(".sav")).collect();
    mine.sort();
    while mine.len() > KEEP_BACKUPS {
        let old = mine.remove(0);
        card.remove(&format!("{}/{}", dir, old));
    }
    Ok(path)
}

/// Read copies kept per game (`read_<game>_<date>-<time>.sav`, apart from
/// the pre-write backups so they never push those out).
pub const KEEP_READS: usize = 3;

/// Copy the save as read at boot to `<dir>/read_<game>_<stamp>.sav`, unless
/// the newest read copy already holds the same bytes; keep the last
/// [`KEEP_READS`]. A copy of exactly what the game was handed, for when it
/// misbehaves on a save only one console has.
pub fn dump_read(card: &mut dyn Card, dir: &str, game: Game, when: &str, raw: &[u8]) -> Result<Option<String>, String> {
    card.mkdir(dir);
    let prefix = format!("read_{}_", game.name());
    let mut mine: Vec<String> = card.list(dir).into_iter().filter(|f| f.starts_with(&prefix) && f.ends_with(".sav")).collect();
    mine.sort();
    if let Some(last) = mine.last() {
        if card.read(&format!("{}/{}", dir, last)).map(|b| b == raw).unwrap_or(false) {
            return Ok(None);
        }
    }
    let path = format!("{}/{}{}.sav", dir, prefix, when);
    card.write(&path, raw)?;
    mine.push(format!("{}{}.sav", prefix, when));
    mine.sort();
    while mine.len() > KEEP_READS {
        let old = mine.remove(0);
        card.remove(&format!("{}/{}", dir, old));
    }
    Ok(Some(path))
}

/// Write a cartridge save into the title's save data: re-read what is there
/// now, back it up, write, read back, commit. `sram` must be exactly 32 KB.
/// On success `found.raw` is the new file.
pub fn write_save(
    fs: &mut dyn VcFs,
    card: &mut dyn Card,
    found: &mut Found,
    game: Game,
    sram: &[u8],
    backup_dir: &str,
    when: &str,
    log: &mut dyn FnMut(&str),
) -> Result<(), String> {
    if sram.len() != SRAM_SIZE {
        return Err(format!("a cartridge save is {} bytes, not {}", SRAM_SIZE, sram.len()));
    }
    if !main_checksum_ok(sram) {
        return Err(String::from("the new save fails its own checksum"));
    }
    fs.open(found.tid).map_err(|e| format!("cannot open the save data: {}", e))?;
    let result = (|| {
        // what is in the archive now (the VC game may have saved since boot)
        let now = fs.read(&found.file).map_err(|e| format!("cannot read {}: {}", found.file, e))?;
        if now.len() < SRAM_SIZE {
            return Err(format!("{} is only {} bytes now", found.file, now.len()));
        }
        let kept = backup(card, backup_dir, game, when, &now).map_err(|e| format!("backup failed, nothing written: {}", e))?;
        log(&format!("vc: backed up to {}", kept));
        let mut out = now.clone();
        out[..SRAM_SIZE].copy_from_slice(sram);
        fs.write(&found.file, &out).map_err(|e| format!("write failed: {}", e))?;
        let back = fs.read(&found.file).map_err(|e| format!("read-back failed: {}", e))?;
        if back != out {
            return Err(String::from("the save data did not read back as written; not committed"));
        }
        log(&format!("vc: wrote {} bytes to {}", out.len(), found.file));
        fs.commit().map_err(|e| format!("commit failed: {}", e))?;
        log("vc: committed");
        found.raw = out;
        Ok(())
    })();
    fs.close();
    if let Err(e) = &result {
        log(&format!("vc: save NOT written: {}", e));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::string::ToString;
    use std::vec;

    /// A console in memory: titles, one save archive per title, journalled
    /// writes that only land on commit.
    #[derive(Default)]
    struct Fake {
        titles: Option<Vec<u64>>,
        saves: BTreeMap<u64, BTreeMap<String, Vec<u8>>>,
        denied: Vec<u64>,
        open: Option<u64>,
        pending: BTreeMap<String, Vec<u8>>,
        fail_write: bool,
        fail_commit: bool,
        commits: usize,
    }
    impl VcFs for Fake {
        fn titles(&mut self) -> Result<Vec<u64>, String> {
            self.titles.clone().ok_or_else(|| "no am".to_string())
        }
        fn open(&mut self, tid: u64) -> Result<(), String> {
            if self.denied.contains(&tid) {
                return Err("denied".into());
            }
            if !self.saves.contains_key(&tid) {
                return Err("not found".into());
            }
            self.open = Some(tid);
            self.pending.clear();
            Ok(())
        }
        fn files(&mut self) -> Result<Vec<(String, u64)>, String> {
            let t = self.open.ok_or("closed")?;
            Ok(self.saves[&t].iter().map(|(k, v)| (k.clone(), v.len() as u64)).collect())
        }
        fn read(&mut self, name: &str) -> Result<Vec<u8>, String> {
            let t = self.open.ok_or("closed")?;
            if let Some(p) = self.pending.get(name) {
                return Ok(p.clone());
            }
            self.saves[&t].get(name).cloned().ok_or_else(|| "no file".into())
        }
        fn write(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
            if self.fail_write {
                return Err("card error".into());
            }
            self.pending.insert(name.to_string(), data.to_vec());
            Ok(())
        }
        fn commit(&mut self) -> Result<(), String> {
            if self.fail_commit {
                return Err("commit error".into());
            }
            let t = self.open.ok_or("closed")?;
            for (k, v) in std::mem::take(&mut self.pending) {
                self.saves.get_mut(&t).unwrap().insert(k, v);
            }
            self.commits += 1;
            Ok(())
        }
        fn close(&mut self) {
            self.pending.clear(); // uncommitted writes are lost
            self.open = None;
        }
    }

    #[derive(Default)]
    struct FakeCard {
        files: BTreeMap<String, Vec<u8>>,
        fail: bool,
    }
    impl Card for FakeCard {
        fn list(&mut self, dir: &str) -> Vec<String> {
            let p = format!("{}/", dir);
            self.files.keys().filter_map(|k| k.strip_prefix(&p).map(|s| s.to_string())).collect()
        }
        fn mkdir(&mut self, _dir: &str) {}
        fn write(&mut self, path: &str, data: &[u8]) -> Result<(), String> {
            if self.fail {
                return Err("card full".into());
            }
            self.files.insert(path.to_string(), data.to_vec());
            Ok(())
        }
        fn read(&mut self, path: &str) -> Result<Vec<u8>, String> {
            self.files.get(path).cloned().ok_or_else(|| "missing".into())
        }
        fn remove(&mut self, path: &str) {
            self.files.remove(path);
        }
    }

    /// A 32 KB save with a game in it (the checksum right), byte `fill`.
    fn game_sram(fill: u8) -> Vec<u8> {
        let mut s = vec![fill; SRAM_SIZE];
        let sum = s[0x2598..0x3523].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        s[0x3523] = !sum;
        s
    }

    const RED: u64 = 0x0004_0000_0017_1000;

    fn console(file: &str, data: Vec<u8>) -> Fake {
        let mut f = Fake { titles: Some(vec![0x0004_0000_0003_0800, RED]), ..Default::default() };
        f.saves.insert(RED, BTreeMap::from([(file.to_string(), data)]));
        f
    }

    #[test]
    fn finds_the_title_and_its_save() {
        let mut fs = console("sav.dat", game_sram(7));
        let mut lines = Vec::new();
        let found = probe(&mut fs, Game::Red, None, &mut |l| lines.push(l.to_string())).unwrap();
        assert_eq!(found.tid, RED);
        assert_eq!(found.file, "sav.dat");
        assert!(found.has_game());
        assert!(lines.iter().any(|l| l.contains("found Red title 0004000000171000")));
        assert!(lines.iter().any(|l| l.contains("sav.dat save 32768 bytes")));
        assert!(fs.open.is_none(), "the archive is closed after reading");
    }

    #[test]
    fn no_title_no_option() {
        let mut fs = console("sav.dat", game_sram(7));
        let mut lines = Vec::new();
        assert!(probe(&mut fs, Game::Blue, None, &mut |l| lines.push(l.to_string())).is_none());
        assert!(lines.last().unwrap().contains("no Blue title"));
    }

    #[test]
    fn access_denied_hides_the_option() {
        let mut fs = console("sav.dat", game_sram(7));
        fs.denied.push(RED);
        let mut lines = Vec::new();
        assert!(probe(&mut fs, Game::Red, None, &mut |l| lines.push(l.to_string())).is_none());
        assert!(lines.last().unwrap().contains("cannot open the Red save data (denied)"));
    }

    #[test]
    fn without_the_title_list_the_known_id_is_tried() {
        let mut fs = console("sav.dat", game_sram(7));
        fs.titles = None;
        let mut lines = Vec::new();
        assert!(probe(&mut fs, Game::Red, None, &mut |l| lines.push(l.to_string())).is_some());
        assert!(lines[0].contains("title list unavailable"));
    }

    #[test]
    fn an_override_names_another_title() {
        let other = 0x0004_0000_0017_1400u64;
        let mut fs = console("sav.dat", game_sram(7));
        fs.titles.as_mut().unwrap().push(other);
        fs.saves.insert(other, BTreeMap::from([("sav.dat".to_string(), game_sram(9))]));
        assert_eq!(title_override("# mine\nred = 0004000000171400\nblue=zz", Game::Red), Some(other));
        assert_eq!(title_override("red=0004000000171400", Game::Blue), None);
        let found = probe(&mut fs, Game::Red, Some(other), &mut |_| {}).unwrap();
        assert_eq!(found.raw[0], 9);
        // named but missing from the title list: tried anyway
        fs.titles.as_mut().unwrap().retain(|t| *t != other);
        let mut lines = Vec::new();
        assert!(probe(&mut fs, Game::Red, Some(other), &mut |l| lines.push(l.to_string())).is_some());
        assert!(lines.iter().any(|l| l.contains("trying it anyway")));
    }

    #[test]
    fn picks_sav_dat_else_the_smallest_big_file() {
        let f = |v: &[(&str, u64)]| pick_file(&v.iter().map(|(a, b)| (a.to_string(), *b)).collect::<Vec<_>>()).map(|x| x.0);
        assert_eq!(f(&[("a.bin", 40000), ("sav.dat", 32768)]).as_deref(), Some("sav.dat"));
        assert_eq!(f(&[("big", 70000), ("save.bin", 32800), ("tiny", 10)]).as_deref(), Some("save.bin"));
        assert_eq!(f(&[("tiny", 10)]), None);
    }

    #[test]
    fn an_empty_save_is_found_but_holds_no_game() {
        let mut fs = console("sav.dat", vec![0xff; SRAM_SIZE]);
        let found = probe(&mut fs, Game::Red, None, &mut |_| {}).unwrap();
        assert!(!found.has_game());
    }

    #[test]
    fn writes_with_a_backup_and_keeps_the_trailer() {
        let mut old = game_sram(1);
        old.extend_from_slice(b"TRAILER!");
        let mut fs = console("sav.dat", old.clone());
        let mut card = FakeCard::default();
        let mut found = probe(&mut fs, Game::Red, None, &mut |_| {}).unwrap();
        let new = game_sram(2);
        let mut lines = Vec::new();
        write_save(&mut fs, &mut card, &mut found, Game::Red, &new, "sdmc:/b", "20261011-120000", &mut |l| lines.push(l.to_string())).unwrap();
        let on_console = &fs.saves[&RED]["sav.dat"];
        assert_eq!(&on_console[..SRAM_SIZE], &new[..]);
        assert_eq!(&on_console[SRAM_SIZE..], b"TRAILER!");
        assert_eq!(card.files["sdmc:/b/red_20261011-120000.sav"], old);
        assert_eq!(fs.commits, 1);
        let order: Vec<&str> = lines.iter().map(|l| l.split_whitespace().nth(1).unwrap_or("")).collect();
        assert_eq!(order, ["backed", "wrote", "committed"]);
    }

    #[test]
    fn no_backup_no_write() {
        let mut fs = console("sav.dat", game_sram(1));
        let mut card = FakeCard { fail: true, ..Default::default() };
        let mut found = probe(&mut fs, Game::Red, None, &mut |_| {}).unwrap();
        let err = write_save(&mut fs, &mut card, &mut found, Game::Red, &game_sram(2), "sdmc:/b", "x", &mut |_| {}).unwrap_err();
        assert!(err.contains("backup failed"));
        assert_eq!(fs.saves[&RED]["sav.dat"][0], 1, "the old save is untouched");
        assert_eq!(fs.commits, 0);
    }

    #[test]
    fn a_failed_write_or_commit_leaves_the_old_save() {
        for (w, c) in [(true, false), (false, true)] {
            let mut fs = console("sav.dat", game_sram(1));
            fs.fail_write = w;
            fs.fail_commit = c;
            let mut card = FakeCard::default();
            let mut found = probe(&mut fs, Game::Red, None, &mut |_| {}).unwrap();
            assert!(write_save(&mut fs, &mut card, &mut found, Game::Red, &game_sram(2), "sdmc:/b", "x", &mut |_| {}).is_err());
            assert_eq!(fs.saves[&RED]["sav.dat"][0], 1);
            assert_eq!(found.raw[0], 1);
        }
    }

    #[test]
    fn refuses_a_save_that_is_not_one() {
        let mut fs = console("sav.dat", game_sram(1));
        let mut card = FakeCard::default();
        let mut found = probe(&mut fs, Game::Red, None, &mut |_| {}).unwrap();
        assert!(write_save(&mut fs, &mut card, &mut found, Game::Red, &[0u8; 100], "d", "x", &mut |_| {}).is_err());
        assert!(write_save(&mut fs, &mut card, &mut found, Game::Red, &vec![0x12u8; SRAM_SIZE], "d", "x", &mut |_| {}).is_err());
        assert!(card.files.is_empty());
    }

    #[test]
    fn keeps_the_last_ten_backups_per_game() {
        let mut card = FakeCard::default();
        card.files.insert("d/blue_20200101-000000.sav".into(), vec![1]);
        for i in 0..12 {
            backup(&mut card, "d", Game::Red, &format!("20261011-1200{:02}", i), &[i as u8]).unwrap();
        }
        let reds: Vec<String> = card.list("d").into_iter().filter(|f| f.starts_with("red_")).collect();
        assert_eq!(reds.len(), KEEP_BACKUPS);
        assert_eq!(reds[0], "red_20261011-120002.sav");
        assert!(card.files.contains_key("d/blue_20200101-000000.sav"), "other games' backups are left alone");
        // the same second twice gets a second name
        backup(&mut card, "d", Game::Red, "20261011-120011", &[99]).unwrap();
        assert!(card.files.contains_key("d/red_20261011-120011_2.sav"));
    }

    #[test]
    fn read_copies_skip_repeats_and_keep_three() {
        let mut card = FakeCard::default();
        card.files.insert("d/red_20200101-000000.sav".into(), vec![9]);
        assert!(dump_read(&mut card, "d", Game::Red, "20261011-100000", &[1]).unwrap().is_some());
        assert!(dump_read(&mut card, "d", Game::Red, "20261011-100001", &[1]).unwrap().is_none(), "same bytes: no new copy");
        for i in 2..7 {
            dump_read(&mut card, "d", Game::Red, &format!("20261011-10000{}", i), &[i as u8]).unwrap();
        }
        let reads: Vec<String> = card.list("d").into_iter().filter(|f| f.starts_with("read_red_")).collect();
        assert_eq!(reads.len(), KEEP_READS);
        assert!(card.files.contains_key("d/red_20200101-000000.sav"), "pre-write backups untouched");
    }

    #[test]
    fn stamps_read_as_dates() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_791_720_000), "20261011-120000");
    }
}
