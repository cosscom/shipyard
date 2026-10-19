package runs

import (
	"sort"
	"strconv"
	"strings"
)

// upsert puts a step's record into the run's step tree by its path:
// "2" is the third top-level step, "2.r1.0" the first step of a loop's
// first round, "3.i4.1" the second step of a map's fifth item.
func upsert(steps *[]StepRun, sr StepRun) {
	segs := strings.Split(sr.Path, ".")
	list := steps
	for k := range segs {
		p := strings.Join(segs[:k+1], ".")
		i := -1
		for n := range *list {
			if (*list)[n].Path == p {
				i = n
				break
			}
		}
		if i < 0 {
			node := StepRun{Path: p, ID: segs[k], Kind: groupKind(segs[k])}
			*list = append(*list, node)
			sort.SliceStable(*list, func(a, b int) bool { return segLess(lastSeg((*list)[a].Path), lastSeg((*list)[b].Path)) })
			for n := range *list {
				if (*list)[n].Path == p {
					i = n
					break
				}
			}
		}
		if k == len(segs)-1 {
			cur := &(*list)[i]
			children, started := cur.Children, cur.Started
			*cur = sr
			cur.Children = children
			if cur.Started.IsZero() {
				cur.Started = started
			}
			return
		}
		list = &(*list)[i].Children
	}
}

func lastSeg(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func groupKind(seg string) string {
	if seg == "" {
		return ""
	}
	if _, err := strconv.Atoi(seg); err == nil {
		return ""
	}
	switch seg[0] {
	case 'r':
		return "round"
	case 'i':
		return "item"
	case 't':
		return "then"
	case 'e':
		return "else"
	case 'v':
		return "evaluation"
	}
	return seg
}

// segLess orders path segments naturally: 2 before 10, r2 before r10.
func segLess(a, b string) bool {
	pa, na := splitSeg(a)
	pb, nb := splitSeg(b)
	if pa != pb {
		return pa < pb
	}
	return na < nb
}

func splitSeg(s string) (string, int) {
	i := 0
	for i < len(s) && (s[i] < '0' || s[i] > '9') {
		i++
	}
	n, _ := strconv.Atoi(s[i:])
	return s[:i], n
}
