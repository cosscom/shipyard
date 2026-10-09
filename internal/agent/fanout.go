package agent

import "sync"

// fanOutLimit is how many boxes one question is put to at a time.
const fanOutLimit = 8

// fanOut runs ask for each of n boxes, at most fanOutLimit at a time, and
// waits for them all: asking every box in turn would take as long as all
// their answers together, and a box that is slow or away holds up the
// rest by its whole timeout.
func fanOut(n int, ask func(i int)) {
	sem := make(chan struct{}, fanOutLimit)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			ask(i)
		}()
	}
	wg.Wait()
}
