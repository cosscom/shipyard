use shipyard_statefile::{home, lock, user_dir, write, write_with_backup, Cache};
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, FileTimes};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = env::temp_dir().join(format!(
            "shipyard-statefile-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

struct EnvRestore(Vec<(&'static str, Option<OsString>)>);

impl EnvRestore {
    fn new(names: &[&'static str]) -> Self {
        Self(
            names
                .iter()
                .map(|name| (*name, env::var_os(name)))
                .collect(),
        )
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => env::set_var(name, value),
                None => env::remove_var(name),
            }
        }
    }
}

#[test]
fn paths_match_go_overrides_and_defaults() {
    let _guard = ENV_LOCK.lock().unwrap();
    let _restore = EnvRestore::new(&["BERTH_HOME", "BERTH_USER_DIR", "HOME", "XDG_CONFIG_HOME"]);
    let temp = TempDir::new();
    env::set_var("HOME", &temp.0);
    env::remove_var("BERTH_HOME");
    env::remove_var("BERTH_USER_DIR");
    env::remove_var("XDG_CONFIG_HOME");

    assert_eq!(user_dir().unwrap(), temp.join(".berth"));
    #[cfg(target_os = "macos")]
    assert_eq!(
        home().unwrap(),
        temp.join("Library/Application Support/berth")
    );
    #[cfg(target_os = "linux")]
    {
        assert_eq!(home().unwrap(), temp.join(".config/berth"));
        env::set_var("XDG_CONFIG_HOME", "relative/config");
        assert!(home().is_err());
        env::set_var("XDG_CONFIG_HOME", &temp.0);
        assert_eq!(home().unwrap(), temp.join("berth"));
    }

    env::set_var("BERTH_HOME", "relative/home");
    assert!(home().is_err());
    env::set_var("BERTH_USER_DIR", "relative/user");
    assert!(user_dir().is_err());
    env::set_var("BERTH_HOME", temp.join("state"));
    env::set_var("BERTH_USER_DIR", temp.join("handwritten"));
    assert_eq!(home().unwrap(), temp.join("state"));
    assert_eq!(user_dir().unwrap(), temp.join("handwritten"));
}

#[test]
fn write_is_private_and_leaves_no_temporary_files() {
    let temp = TempDir::new();
    let path = temp.join("nested/state.json");
    write(&path, b"one").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"one");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn write_with_backup_preserves_previous_nonempty_content_only_on_change() {
    let temp = TempDir::new();
    let path = temp.join("clients.json");
    let backup = temp.join("clients.json.bak");
    write_with_backup(&path, b"first").unwrap();
    assert!(!backup.exists());
    write_with_backup(&path, b"second").unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"first");
    write_with_backup(&path, b"second").unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"first");
    write_with_backup(&path, b"").unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"second");
    write_with_backup(&path, b"third").unwrap();
    assert_eq!(fs::read(&backup).unwrap(), b"second");
    assert_eq!(
        fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn lock_serializes_concurrent_read_modify_write() {
    let temp = TempDir::new();
    let path = temp.join("counter");
    write(&path, &[0]).unwrap();
    thread::scope(|scope| {
        for _ in 0..50 {
            let path = &path;
            scope.spawn(move || {
                let _guard = lock(path).unwrap();
                let count = fs::read(path).unwrap()[0];
                write(path, &[count + 1]).unwrap();
            });
        }
    });
    assert_eq!(fs::read(&path).unwrap(), [50]);
    assert_eq!(
        fs::metadata(temp.join("counter.lock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn cross_process_lock_child() {
    let Some(path) = env::var_os("SHIPYARD_STATEFILE_CHILD_PATH") else {
        return;
    };
    let path = PathBuf::from(path);
    write(path.with_extension("ready"), b"ready").unwrap();
    let _guard = lock(&path).unwrap();
    write(path.with_extension("entered"), b"entered").unwrap();
}

#[test]
fn lock_blocks_a_second_process_until_release() {
    let temp = TempDir::new();
    let path = temp.join("shared");
    let guard = lock(&path).unwrap();
    let mut child = Command::new(env::current_exe().unwrap())
        .arg("--exact")
        .arg("cross_process_lock_child")
        .arg("--nocapture")
        .env("SHIPYARD_STATEFILE_CHILD_PATH", &path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let startup_deadline = Instant::now() + Duration::from_secs(5);
    while !path.with_extension("ready").exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("child exited before attempting lock: {status}");
        }
        if Instant::now() >= startup_deadline {
            child.kill().unwrap();
            panic!("child did not start lock attempt");
        }
        thread::sleep(Duration::from_millis(10));
    }
    thread::sleep(Duration::from_millis(50));
    assert!(!path.with_extension("entered").exists());
    assert!(child.try_wait().unwrap().is_none());
    drop(guard);
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("child did not acquire lock after release");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    assert_eq!(
        fs::read(path.with_extension("entered")).unwrap(),
        b"entered"
    );
}

fn load_text(cache: &Cache<String>, path: &Path, reads: &AtomicUsize) -> io::Result<String> {
    cache.load(path, || {
        reads.fetch_add(1, Ordering::Relaxed);
        match fs::read(path) {
            Ok(data) => Ok(String::from_utf8(data).unwrap()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok("none".to_owned()),
            Err(err) => Err(err),
        }
    })
}

#[test]
fn cache_reloads_missing_created_replaced_and_removed_files() {
    let temp = TempDir::new();
    let path = temp.join("routes.json");
    let cache = Cache::default();
    let reads = AtomicUsize::new(0);
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "none");
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "none");
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    write(&path, b"aaaa").unwrap();
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "aaaa");
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "aaaa");
    assert_eq!(reads.load(Ordering::Relaxed), 2);
    write(&path, b"bbbb").unwrap();
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "bbbb");
    assert_eq!(reads.load(Ordering::Relaxed), 3);
    fs::remove_file(&path).unwrap();
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "none");
    assert_eq!(reads.load(Ordering::Relaxed), 4);
}

#[test]
fn cache_detects_in_place_edit_with_same_size_and_mtime() {
    let temp = TempDir::new();
    let path = temp.join("routes.json");
    write(&path, b"aaaa").unwrap();
    let cache = Cache::default();
    let reads = AtomicUsize::new(0);
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "aaaa");
    let original = fs::metadata(&path).unwrap();
    thread::sleep(Duration::from_millis(20));
    fs::write(&path, b"bbbb").unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(original.modified().unwrap()))
        .unwrap();
    let updated = fs::metadata(&path).unwrap();
    assert_eq!(original.len(), updated.len());
    assert_eq!(original.modified().unwrap(), updated.modified().unwrap());
    assert_eq!(load_text(&cache, &path, &reads).unwrap(), "bbbb");
    assert_eq!(reads.load(Ordering::Relaxed), 2);
}

#[test]
fn cache_keeps_no_read_errors_or_stat_errors() {
    let temp = TempDir::new();
    let path = temp.join("routes.json");
    write(&path, b"x").unwrap();
    let cache = Cache::default();
    assert!(cache
        .load(&path, || -> io::Result<i32> {
            Err(io::Error::other("unreadable"))
        })
        .is_err());
    assert_eq!(cache.load(&path, || Ok::<_, io::Error>(7)).unwrap(), 7);

    // A self referential symlink makes stat fail with ELOOP. Reads must run
    // every time instead of consulting or updating the cached entry.
    let loop_path = temp.join("loop");
    std::os::unix::fs::symlink("loop", &loop_path).unwrap();
    let attempts = AtomicUsize::new(0);
    for _ in 0..2 {
        assert_eq!(
            cache
                .load(&loop_path, || {
                    attempts.fetch_add(1, Ordering::Relaxed);
                    Ok::<_, io::Error>(9)
                })
                .unwrap(),
            9
        );
    }
    assert_eq!(attempts.load(Ordering::Relaxed), 2);
}

#[test]
fn cache_shares_one_successful_read_between_threads() {
    let temp = TempDir::new();
    let path = temp.join("shared");
    write(&path, b"ready").unwrap();
    let cache = Arc::new(Cache::default());
    let reads = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..32 {
            let cache = Arc::clone(&cache);
            let reads = &reads;
            let path = &path;
            scope.spawn(move || {
                assert_eq!(load_text(&cache, path, reads).unwrap(), "ready");
            });
        }
    });
    assert_eq!(reads.load(Ordering::Relaxed), 1);
}
