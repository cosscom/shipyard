package statefile

import (
	"errors"
	"io/fs"
	"os"
	"sync"
)

// Cache keeps what was read from one small state file and reads it again
// only once the file has changed. Some files are read on every request
// (the proxy's routes on each one it relays), so edits made by another
// process (the CLI) still apply at once, without a read of the file each
// time: a stat says whether it changed.
//
// Files here are replaced whole (Write renames a new file over the old),
// so a change shows as a new inode, size, modification or change time.
type Cache[T any] struct {
	mu  sync.Mutex
	key fileKey
	ok  bool
	val T
}

// fileKey is what tells one version of a file from another. missing is a
// file that isn't there.
type fileKey struct {
	missing     bool
	dev, ino    uint64
	size        int64
	mtime, ctim int64 // nanoseconds
}

func keyOf(path string) (fileKey, error) {
	fi, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return fileKey{missing: true}, nil
	}
	if err != nil {
		return fileKey{}, err
	}
	k := fileKey{size: fi.Size(), mtime: fi.ModTime().UnixNano()}
	statKey(fi, &k)
	return k, nil
}

// Load returns what read made of path, from the last time it ran if the
// file is as it was then. read's result is shared by every caller until
// the file changes: callers must not change it. Errors are not kept, so a
// file that could not be read is tried again next time.
func (c *Cache[T]) Load(path string, read func() (T, error)) (T, error) {
	// The stat comes before the read: a file replaced in between is read
	// again next time, rather than its old version kept under its new key.
	k, err := keyOf(path)
	if err != nil {
		return read()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ok && c.key == k {
		return c.val, nil
	}
	v, err := read()
	if err != nil {
		c.ok = false
		return v, err
	}
	c.key, c.val, c.ok = k, v, true
	return v, nil
}
