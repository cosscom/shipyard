package statefile

import (
	"io/fs"
	"syscall"
)

func statKey(fi fs.FileInfo, k *fileKey) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		k.dev, k.ino = uint64(st.Dev), st.Ino
		k.ctim = st.Ctim.Nano()
	}
}
