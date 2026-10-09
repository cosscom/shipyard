import { type ComponentType, lazy, useState } from "react";

// lazyView is a page (Settings, Automations, Team setup…) that loads on
// first use rather than with the app, so they don't all weigh on its start.
// preloadViews fetches them once the app is up and idle, and a view whose
// code is in by the time it shows draws at once, without suspending (no
// blank frame on a first visit). Render it under a <Suspense>.
const loaders: (() => Promise<unknown>)[] = [];

export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const get = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (err) => {
        // A failed fetch can be tried again on the next visit.
        pending = undefined;
        throw err;
      },
    ));
  loaders.push(get);
  const Lazy = lazy(() => get().then((c) => ({ default: c })));
  function View(props: P) {
    // Chosen once per mount: switching from Lazy to the loaded component
    // under a mounted view would remount it.
    const [Ready] = useState(() => loaded);
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  }
  return View;
}

// preloadViews loads every lazy view's code a while after the app starts,
// one at a time when the main thread is free. WebKit (the macOS and Linux
// app) has no requestIdleCallback; there it is a timer.
export function preloadViews(): () => void {
  const ric = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
  const idle = (cb: () => void) => (ric ? ric(cb, { timeout: 2000 }) : window.setTimeout(cb, 50));
  const cancel = (h: number) => (ric ? window.cancelIdleCallback(h) : window.clearTimeout(h));
  let i = 0;
  let handle = 0;
  let stopped = false;
  const next = () => {
    const load = loaders[i++];
    if (!load || stopped) return;
    void load()
      .catch(() => {})
      .finally(() => {
        if (!stopped) handle = idle(next);
      });
  };
  // After the first screen has settled.
  const start = window.setTimeout(() => (handle = idle(next)), 1500);
  return () => {
    stopped = true;
    window.clearTimeout(start);
    cancel(handle);
  };
}
