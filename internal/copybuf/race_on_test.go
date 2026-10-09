//go:build race

package copybuf

// The race detector drops pooled items at random, so pooling cannot be
// measured under it.
const raceEnabled = true
