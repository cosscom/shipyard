//! Private state files shared by Shipyard processes.
//!
//! This crate mirrors the Go `internal/statefile` package. Callers that update
//! a file based on its old contents must hold [`lock`] across the whole read,
//! modification, and write.

use std::env;
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions, Permissions};
use std::io::{self, Write as _};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

fn nonempty_env(name: &str) -> Option<OsString> {
    env::var_os(name).filter(|value| !value.is_empty())
}

fn invalid_input(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn absolute_override(name: &str) -> io::Result<Option<PathBuf>> {
    let Some(value) = nonempty_env(name) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(invalid_input(&format!("{name} must be an absolute path")));
    }
    Ok(Some(path))
}

/// The state directory: `BERTH_HOME`, or the OS config directory plus `berth`.
pub fn home() -> io::Result<PathBuf> {
    if let Some(path) = absolute_override("BERTH_HOME")? {
        return Ok(path);
    }

    #[cfg(target_os = "macos")]
    {
        Ok(user_home()?.join("Library/Application Support/berth"))
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(value) = nonempty_env("XDG_CONFIG_HOME") {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(invalid_input("path in $XDG_CONFIG_HOME is relative"));
            }
            return Ok(path.join("berth"));
        }
        Ok(user_home()?.join(".config/berth"))
    }
}

fn user_home() -> io::Result<PathBuf> {
    nonempty_env("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| invalid_input("$HOME is not defined"))
}

/// The directory for hand written hooks, themes, templates, and plugins.
pub fn user_dir() -> io::Result<PathBuf> {
    if let Some(path) = absolute_override("BERTH_USER_DIR")? {
        return Ok(path);
    }
    Ok(user_home()?.join(".berth"))
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn private_dir(path: &Path) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

struct Temporary(PathBuf);

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn temporary_file(path: &Path) -> io::Result<(Temporary, File)> {
    let base = path
        .file_name()
        .ok_or_else(|| invalid_input("state file path has no file name"))?;
    let mut name = OsString::from(".");
    name.push(base);
    name.push("-");
    for _ in 0..100 {
        let mut candidate = name.clone();
        candidate.push(format!(
            "{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let candidate = parent(path).join(candidate);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(file) => return Ok((Temporary(candidate), file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find a unique state file name",
    ))
}

/// Replace a file atomically with owner only permissions.
pub fn write(path: impl AsRef<Path>, data: &[u8]) -> io::Result<()> {
    let path = path.as_ref();
    private_dir(parent(path))?;
    let (temporary, mut file) = temporary_file(path)?;
    file.set_permissions(Permissions::from_mode(0o600))?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary.0, path)
}

/// Replace a file, saving its nonempty previous contents when they change.
///
/// Callers doing read modify write must hold [`lock`] around this call.
pub fn write_with_backup(path: impl AsRef<Path>, data: &[u8]) -> io::Result<()> {
    let path = path.as_ref();
    let previous = match fs::read(path) {
        Ok(data) => data,
        Err(err) if err.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return Err(err),
    };
    if !previous.is_empty() && previous != data {
        write(suffixed(path, ".bak"), &previous)?;
    }
    write(path, data)
}

/// An exclusive advisory lock, released when the guard is dropped.
pub struct FileLock(File);

impl Drop for FileLock {
    fn drop(&mut self) {
        // Closing the descriptor would also release the lock. Unlocking first
        // mirrors the Go implementation and makes the release explicit.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Lock `path + ".lock"` across processes for a read modify write operation.
pub fn lock(path: impl AsRef<Path>) -> io::Result<FileLock> {
    let path = path.as_ref();
    private_dir(parent(path))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(suffixed(path, ".lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileLock(file))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileKey {
    Missing,
    Present {
        device: u64,
        inode: u64,
        size: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    },
}

fn file_key(path: &Path) -> io::Result<FileKey> {
    match fs::metadata(path) {
        Ok(meta) => Ok(key_of_metadata(&meta)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(FileKey::Missing),
        Err(err) => Err(err),
    }
}

fn key_of_metadata(meta: &Metadata) -> FileKey {
    FileKey::Present {
        device: meta.dev(),
        inode: meta.ino(),
        size: meta.size(),
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
    }
}

/// A small file cache shared across threads. The callback's successful value
/// is cloned for callers until the file's stat key changes. Callback errors
/// are never cached. A stat error runs the callback without caching its result.
pub struct Cache<T> {
    state: Mutex<Option<(FileKey, T)>>,
}

impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }
}

impl<T: Clone> Cache<T> {
    pub fn load<E, F>(&self, path: impl AsRef<Path>, read: F) -> Result<T, E>
    where
        F: FnOnce() -> Result<T, E>,
    {
        // Stat before taking the lock. A replacement between stat and read
        // is re-read on the next load instead of being cached under its key.
        let key = match file_key(path.as_ref()) {
            Ok(key) => key,
            Err(_) => return read(),
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((cached_key, value)) = &*state {
            if *cached_key == key {
                return Ok(value.clone());
            }
        }
        match read() {
            Ok(value) => {
                *state = Some((key, value.clone()));
                Ok(value)
            }
            Err(err) => {
                *state = None;
                Err(err)
            }
        }
    }
}
