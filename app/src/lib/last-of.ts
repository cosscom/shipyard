// lastOf remembers fn's last answer for the same arguments (compared by
// identity): a memo every component that asks shares, where each one's own
// useMemo would work the same thing out again (Home's dozen widgets over
// every session, lib/hooks use-agent-counts).
export function lastOf<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { args: A; out: R } | undefined;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.out;
    const out = fn(...args);
    last = { args, out };
    return out;
  };
}
