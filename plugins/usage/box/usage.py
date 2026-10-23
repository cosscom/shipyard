"""Usage and accounts for the Usage plugin, run on a box through exec.

  usage.py report [DAYS]      token usage from Claude Code and Codex transcripts
  usage.py accounts           logins per agent, and which one each session uses
  usage.py mkaccount AGENT NAME   an empty account folder to sign in to

Only counts and labels leave the box: never prompts, transcripts or
credentials. Account details are the email and plan the agents record about
the signed-in user. Each transcript's summary is cached by size and
modification time under ~/.cache/berth-usage, so a report reads only what
changed; a first run on a box with years of transcripts may need a few runs
(it reports `partial`).
"""
import base64
import datetime as dt
import glob
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HOME = pathlib.Path.home()
CACHE = HOME / ".cache" / "berth-usage" / "files.json"
ACCOUNTS = HOME / ".berth" / "accounts"
LIMITS = HOME / ".berth" / "limits"
BUDGET_S = float(os.environ.get("BERTH_USAGE_BUDGET", "45"))
MAX_OUT = 60_000
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Bump when the parsers change, so cached summaries are read again.
CACHE_VERSION = 2


def local_day(ts):
    try:
        t = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return t.astimezone().date().isoformat()
    except ValueError:
        return None


def iso(ts):
    try:
        return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


# --- accounts ----------------------------------------------------------------


# "default" is always the agent's own folder: this script runs through exec,
# in a worktree whose environment may already pick another account.
def claude_dirs():
    default = HOME / ".claude"
    out = [("default", default)]
    out += [(p.name, p) for p in sorted((ACCOUNTS / "claude").glob("*")) if p.is_dir()]
    return out


def codex_dirs():
    default = HOME / ".codex"
    out = [("default", default)]
    out += [(p.name, p) for p in sorted((ACCOUNTS / "codex").glob("*")) if p.is_dir()]
    return out


def read_json(p):
    try:
        return json.loads(pathlib.Path(p).read_text())
    except (OSError, ValueError):
        return None


def jwt_claims(token):
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError, TypeError):
        return {}


def claude_account(name, d):
    # The default login keeps its profile beside the home folder; another
    # config folder keeps it inside.
    profile = read_json(HOME / ".claude.json") if name == "default" else read_json(d / ".claude.json")
    o = (profile or {}).get("oauthAccount") or {}
    tier = o.get("userRateLimitTier") or o.get("organizationRateLimitTier") or ""
    return {
        "agent": "claude", "id": name, "dir": str(d), "exists": d.is_dir(),
        "signed_in": bool(o),
        "email": o.get("emailAddress"), "name": o.get("displayName"),
        "org": o.get("organizationName"), "billing": o.get("billingType"), "tier": tier or None,
    }


def codex_account(name, d):
    auth = read_json(d / "auth.json") or {}
    claims = jwt_claims(((auth.get("tokens") or {}).get("id_token")) or "")
    plan = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")
    method = "chatgpt" if auth.get("tokens") else ("api key" if auth.get("OPENAI_API_KEY") else None)
    return {
        "agent": "codex", "id": name, "dir": str(d), "exists": d.is_dir(),
        "signed_in": bool(method), "method": method,
        "email": claims.get("email"), "plan": plan,
    }


def session_accounts():
    """Which account each berth session was started with, from its tmux
    environment. A session without one uses the box default."""
    out = {}
    try:
        names = subprocess.run(["tmux", "-L", "berth", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True, timeout=10).stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        return out
    for n in names:
        try:
            env = subprocess.run(["tmux", "-L", "berth", "show-environment", "-t", "=" + n], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            continue
        row = {}
        for line in env.splitlines():
            k, _, v = line.partition("=")
            if k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
                row[k] = v
        out[n] = row
    return out


def accounts():
    rows = [claude_account(n, d) for n, d in claude_dirs()] + [codex_account(n, d) for n, d in codex_dirs()]
    return {"accounts": rows, "sessions": session_accounts(), "home": str(HOME)}


def mkaccount(agent, name):
    if agent not in ("claude", "codex") or not NAME.match(name or "") or name == "default":
        raise SystemExit("usage: mkaccount claude|codex NAME (lowercase letters, digits, dashes)")
    d = ACCOUNTS / agent / name
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    return {"agent": agent, "id": name, "dir": str(d)}


# --- transcripts -------------------------------------------------------------


def add(bucket, day, model, tokens):
    if not day or not any(tokens):
        return
    m = bucket.setdefault(day, {}).setdefault(model or "unknown", [0, 0, 0, 0])
    for i, v in enumerate(tokens):
        m[i] += int(v or 0)


def claude_file(path):
    """A Claude Code transcript's usage: tokens are [input, output,
    cache read, cache write] by day and model. Streamed messages repeat
    their usage, so each message counts once."""
    s = {"sid": None, "cwd": None, "title": None, "first": None, "last": None, "cost": None, "days": {}}
    seen = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line and '"cost-state"' not in line and '"ai-title"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            t = o.get("type")
            s["sid"] = s["sid"] or o.get("sessionId")
            if t == "cost-state":
                s["cost"] = o.get("totalCostUSD")
            elif t == "ai-title":
                s["title"] = (o.get("aiTitle") or o.get("title") or s["title"])
            elif t == "assistant":
                m = o.get("message") or {}
                u = m.get("usage")
                if not u:
                    continue
                key = (m.get("id"), o.get("requestId"))
                if key in seen:
                    continue
                seen.add(key)
                s["cwd"] = s["cwd"] or o.get("cwd")
                ts = o.get("timestamp")
                s["first"] = s["first"] or iso(ts)
                s["last"] = iso(ts) or s["last"]
                add(s["days"], local_day(ts), m.get("model"), [u.get("input_tokens"), u.get("output_tokens"), u.get("cache_read_input_tokens"), u.get("cache_creation_input_tokens")])
    if isinstance(s["title"], str):
        s["title"] = s["title"][:120]
    return s


def codex_file(path):
    """A Codex session's usage, from the growth of its running totals
    between token_count events, and its latest rate-limit window."""
    s = {"sid": None, "cwd": None, "title": None, "first": None, "last": None, "cost": None, "days": {}, "limits": None, "limits_at": None}
    model, prev = None, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if "token_count" not in line and '"turn_context"' not in line and '"session_meta"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get("payload") or {}
            if o.get("type") == "session_meta":
                s["sid"] = p.get("id") or p.get("session_id")
                s["cwd"] = p.get("cwd")
            elif o.get("type") == "turn_context":
                model = p.get("model") or model
                s["cwd"] = s["cwd"] or p.get("cwd")
            elif p.get("type") == "token_count":
                ts = o.get("timestamp")
                if p.get("rate_limits"):
                    s["limits"], s["limits_at"] = p["rate_limits"], iso(ts)
                total = ((p.get("info") or {}).get("total_token_usage")) or None
                if not total:
                    continue
                if prev is not None and total == prev:
                    continue
                d = {k: max(0, int(total.get(k) or 0) - int((prev or {}).get(k) or 0)) for k in ("input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens")}
                prev = total
                s["first"] = s["first"] or iso(ts)
                s["last"] = iso(ts) or s["last"]
                # Codex counts cached input inside input; split them.
                add(s["days"], local_day(ts), model, [d["input_tokens"] - d["cached_input_tokens"], d["output_tokens"], d["cached_input_tokens"], d["cache_write_input_tokens"]])
    return s


# Claude Code's windows in Codex's shape: five_hour is the primary, seven_day
# the secondary.
CLAUDE_WINDOWS = (("five_hour", "primary", 300), ("seven_day", "secondary", 7 * 24 * 60))


def claude_limits():
    """The plan limits Claude Code last passed to a status line, from
    ~/.berth/limits/<account>.json: {"at": ISO time, "limits": the status
    line's rate_limits}. Claude Code writes them nowhere else, so a status
    line has to record them (see the README); without the file there are
    none."""
    out = []
    for name, _ in claude_dirs():
        o = read_json(LIMITS / f"{name}.json")
        if not isinstance(o, dict) or not isinstance(o.get("limits"), dict):
            continue
        windows = {}
        for key, slot, minutes in CLAUDE_WINDOWS:
            w = o["limits"].get(key)
            if isinstance(w, dict) and isinstance(w.get("used_percentage"), (int, float)) and isinstance(w.get("resets_at"), (int, float)):
                windows[slot] = {"used_percent": w["used_percentage"], "window_minutes": minutes, "resets_at": int(w["resets_at"])}
        at = iso(o.get("at") or "")
        if windows and at:
            out.append({"agent": "claude", "account": name, "at": at, "limits": windows})
    return out


def report(days):
    started = time.monotonic()
    CACHE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache = read_json(CACHE) or {}
    if cache.get("_version") != CACHE_VERSION:
        cache = {}
    files = []
    for name, d in claude_dirs():
        files += [("claude", name, p) for p in glob.glob(str(d / "projects" / "**" / "*.jsonl"), recursive=True)]
    for name, d in codex_dirs():
        for sub in ("sessions", "archived_sessions"):
            files += [("codex", name, p) for p in glob.glob(str(d / sub / "**" / "*.jsonl"), recursive=True)]
    cutoff = time.time() - days * 86400
    pending, fresh, live = 0, {}, set()
    # Newest first, so a run that hits its budget has the recent ones.
    for agent, account, path in sorted(files, key=lambda f: -os.path.getmtime(f[2]) if os.path.exists(f[2]) else 0):
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        live.add(path)
        key = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(path)
        if hit and hit.get("key") == key:
            fresh[path] = hit
            continue
        if time.monotonic() - started > BUDGET_S:
            pending += 1
            continue
        try:
            summary = (claude_file if agent == "claude" else codex_file)(path)
        except OSError:
            continue
        fresh[path] = {"key": key, "agent": agent, "account": account, "s": summary}
    # Two reads at once each write their own file; the last one wins, and a
    # cache that can't be saved only means the next read is slower.
    tmp = CACHE.with_name(f"files.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps({"_version": CACHE_VERSION, **fresh}))
        tmp.replace(CACHE)
    except OSError:
        tmp.unlink(missing_ok=True)

    since = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    daily, sessions, limits = {}, {}, {}
    for path, e in fresh.items():
        s, agent, account = e["s"], e["agent"], e["account"]
        for day, models in s["days"].items():
            if day < since:
                continue
            for model, t in models.items():
                if not any(t):
                    continue
                k = (day, agent, account, model, s["cwd"] or "")
                acc = daily.setdefault(k, [0, 0, 0, 0])
                for i in range(4):
                    acc[i] += t[i]
        sid = s["sid"] or os.path.basename(path)
        tot = [sum(m[i] for d in s["days"].values() for m in d.values()) for i in range(4)]
        if not any(tot):
            continue
        row = sessions.setdefault((agent, sid), {"agent": agent, "account": account, "id": sid, "cwd": s["cwd"], "title": s["title"], "first": s["first"], "last": s["last"], "tokens": [0, 0, 0, 0], "cost": None, "models": []})
        for i in range(4):
            row["tokens"][i] += tot[i]
        if s["cost"] is not None:
            row["cost"] = (row["cost"] or 0) + s["cost"]
        row["first"] = min(filter(None, [row["first"], s["first"]]), default=None)
        row["last"] = max(filter(None, [row["last"], s["last"]]), default=None)
        row["title"] = row["title"] or s["title"]
        for d in s["days"].values():
            for m in d:
                if m not in row["models"]:
                    row["models"].append(m)
        if s.get("limits") and (account not in limits or s["limits_at"] > limits[account]["at"]):
            limits[account] = {"agent": agent, "account": account, "at": s["limits_at"], "limits": s["limits"]}

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "days": days, "since": since, "today": dt.date.today().isoformat(), "tz": time.strftime("%Z"),
        "partial": pending > 0, "pending": pending, "files": len(live),
        "columns": ["input", "output", "cache_read", "cache_write"],
        "daily": [[*k, *v] for k, v in sorted(daily.items())],
        "sessions": sorted(sessions.values(), key=lambda r: r["last"] or "", reverse=True),
        "limits": list(limits.values()) + claude_limits(),
    }
    # Fit exec's output: drop the oldest sessions until it does.
    text = json.dumps(out, separators=(",", ":"))
    while len(text) > MAX_OUT and out["sessions"]:
        out["sessions"] = out["sessions"][: max(0, len(out["sessions"]) * 3 // 4)]
        out["truncated"] = True
        text = json.dumps(out, separators=(",", ":"))
    return text


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "report":
        print(report(max(1, min(90, int(argv[2]) if len(argv) > 2 else 30))))
    elif cmd == "accounts":
        print(json.dumps(accounts(), separators=(",", ":")))
    elif cmd == "mkaccount":
        print(json.dumps(mkaccount(*(argv[2:4] + [None, None])[:2])))
    else:
        raise SystemExit("usage: usage.py report [DAYS] | accounts | mkaccount AGENT NAME")


if __name__ == "__main__":
    main(sys.argv)
