"""Usage and accounts for the Usage plugin, run on a box through exec.

  usage.py report [DAYS]      token usage from Claude Code and Codex transcripts,
                              and their plan limits (Claude Code's from /usage)
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
def env_seconds(name, default):
    """A number of seconds from the environment, or default when it is
    missing or not a number: a typo must not cost the whole report."""
    try:
        v = float(os.environ.get(name, default))
        return v if v >= 0 else float(default)
    except ValueError:
        return float(default)


BUDGET_S = env_seconds("BERTH_USAGE_BUDGET", "45")
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
        "org": o.get("organizationName"), "org_id": o.get("organizationUuid"),
        "billing": o.get("billingType"), "tier": tier or None,
        # claude_team, claude_enterprise, claude_max, claude_pro: a team seat
        # records a Max-like tier of its own, so the tier alone misnames it.
        "org_type": o.get("organizationType"),
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
    gone = set(claude_signed_out())
    for r in rows:
        if r["agent"] == "claude" and r["id"] in gone:
            # Kept: who it was, so the person knows which login to sign in.
            r["signed_in"], r["signed_out"] = False, True
    return {"accounts": rows, "sessions": session_accounts(), "home": str(HOME)}


def mkaccount(agent, name):
    if agent not in ("claude", "codex") or not NAME.match(name or "") or name == "default":
        raise SystemExit("usage: mkaccount claude|codex NAME (lowercase letters, digits, dashes)")
    d = ACCOUNTS / agent / name
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    return {"agent": agent, "id": name, "dir": str(d)}


# --- Claude Code's plan limits -----------------------------------------------

# Claude Code writes its limits nowhere on disk, but its own `/usage` prints
# them, off the login the CLI already holds:
#
#   Current session: 31% used · resets Oct 15 at 3:30am (Europe/Paris)
#   Current week (all models): 64% used · resets Oct 19 at 8am (Europe/Paris)
#   Current week (Fable): 32% used · resets Oct 19 at 8am (Europe/Paris)
#
# --print skips the workspace-trust question, --no-session-persistence the
# transcript, --strict-mcp-config every MCP server. Run from one folder of its
# own, so Claude Code files no project for each read. (After Codenotch's
# ClaudeUsageCLI, MIT.)
CLAUDE_LIMITS_CACHE = HOME / ".cache" / "berth-usage" / "claude-limits.json"
# How often each login's /usage is asked (the home widget reads every 5
# minutes while it shows), and how long one read may take: logins are read
# CLAUDE_READERS at a time, so a box with a few waits about as long as for
# one, and a `claude` that hangs costs the report this much at most, never
# its tokens. A timeout of 0 would fail every read: it means the default.
CLAUDE_LIMITS_TTL = env_seconds("BERTH_USAGE_CLAUDE_LIMITS_TTL", "600")
CLAUDE_USAGE_TIMEOUT = env_seconds("BERTH_USAGE_CLAUDE_TIMEOUT", "12") or 12.0
CLAUDE_READERS = 4
# Claude Code runs its hooks on every start, Shipyard's own among them, so
# each read would tell berthd an agent had started and stopped: none run.
CLAUDE_NO_HOOKS = ["--settings", '{"disableAllHooks":true}']
CLAUDE_USAGE_ARGS = ["--print", "--no-session-persistence", "--strict-mcp-config", *CLAUDE_NO_HOOKS, "/usage"]
LIMIT_LINE = re.compile(r"^Current (?:(session)|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$", re.M)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
RESET = re.compile(r"^([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$", re.I)


def reset_epoch(text, now=None):
    """`Oct 19 at 8am (Europe/Paris)` as Unix seconds, or None. No year is
    printed: the candidate nearest now, over last, this and next year, is
    taken, so a window read across New Year lands in the right one. A zone
    this box can't name is read as the box's own, at that date's offset."""
    now = now or dt.datetime.now(dt.timezone.utc)
    text = text.strip()
    zone = None
    if text.endswith(")") and "(" in text:
        name = text[text.rindex("(") + 1:-1]
        text = text[:text.rindex("(")].strip()
        try:
            from zoneinfo import ZoneInfo
            zone = ZoneInfo(name)
        except Exception:
            zone = None
    m = RESET.match(text)
    if not m or m.group(1).lower() not in MONTHS:
        return None
    month, day, hour, minute = MONTHS[m.group(1).lower()], int(m.group(2)), int(m.group(3)) % 12, int(m.group(4) or 0)
    if m.group(5).lower() == "pm":
        hour += 12
    best = None
    for year in (now.year - 1, now.year, now.year + 1):
        try:
            # Without a zone, the box's own as of that date: a fixed offset
            # taken now would be an hour off across a daylight saving change.
            t = dt.datetime(year, month, day, hour, minute, tzinfo=zone) if zone else dt.datetime(year, month, day, hour, minute).astimezone()
        except (ValueError, OverflowError):
            continue
        if best is None or abs((t - now).total_seconds()) < abs((best - now).total_seconds()):
            best = t
    return int(best.timestamp()) if best else None


def parse_claude_usage(text, now=None):
    """`/usage`'s limit lines as the plugin's limits: the session window
    first, the all-models week second, other weeks (one model's) after. None
    without a session line: a reading with a hole in it is not shown."""
    windows = {}
    for m in LIMIT_LINE.finditer(text or ""):
        kind = "session" if m.group(1) else ("week" if m.group(2).lower() == "all models" else "week:" + m.group(2))
        if kind in windows:
            continue
        w = {"used_percent": float(m.group(3)), "window_minutes": 300 if kind == "session" else 7 * 24 * 60,
             "resets_at": reset_epoch(m.group(4), now) if m.group(4) else None}
        if kind.startswith("week:"):
            w["label"] = f"Weekly limit ({m.group(2)})"
        windows[kind] = w
    if "session" not in windows:
        return None
    return {"primary": windows.pop("session"), "secondary": windows.pop("week", None), "extra": list(windows.values())}


def claude_binary():
    import shutil
    return shutil.which("claude") or next((str(p) for p in [HOME / ".local" / "bin" / "claude", HOME / ".claude" / "local" / "claude"] if p.exists()), None)


def run_claude(name, d, binary, args, check=False):
    """Claude Code's output for args, run for the login in d. With check, an
    exit status other than 0 raises, as a timeout does."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
    if name != "default":
        env["CLAUDE_CONFIG_DIR"] = str(d)
    # Shipyard's hooks stay quiet for it even where --settings can't reach
    # them (berthd's hook reads this: an agent it drives itself).
    env["BERTH_DRIVER"] = "structured"
    cwd = CLAUDE_LIMITS_CACHE.parent / "claude-usage"
    cwd.mkdir(parents=True, exist_ok=True, mode=0o700)
    # In a process group of its own, so a timeout ends whatever Claude Code
    # started too: a child left holding its stdout would keep this waiting.
    proc = subprocess.Popen([binary, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=CLAUDE_USAGE_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            pass
        try:
            proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        raise
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, args)
    return out


def claude_usage_text(name, d, binary):
    return run_claude(name, d, binary, CLAUDE_USAGE_ARGS, check=True)


# The profile in a login's .claude.json outlives the login itself: when
# Claude Code loses it (a token the server refused), it drops the
# credentials and keeps the profile, so the account still looks signed in
# with its plan. `claude auth status` says what Claude Code holds, locally
# and in about a tenth of a second: {"loggedIn": false} and status 1 when
# signed out.
CLAUDE_AUTH_ARGS = ["auth", "status"]
TIMED_OUT = "timed out"


def claude_logged_in(name, d, binary):
    """True or False, what Claude Code says; None when it says nothing it
    can read (an older Claude Code), TIMED_OUT when it hung."""
    try:
        out = run_claude(name, d, binary, CLAUDE_AUTH_ARGS)
    except subprocess.TimeoutExpired:
        return TIMED_OUT
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        state = json.loads(out or "").get("loggedIn")
    except (ValueError, AttributeError):
        return None
    return state if isinstance(state, bool) else None


def claude_auth(logins, binary):
    """claude_logged_in for each login, CLAUDE_READERS at a time: a hang
    costs one timeout, not one per login."""
    if not logins or not binary:
        return {}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(len(logins), CLAUDE_READERS)) as pool:
        return dict(zip([n for n, _ in logins], pool.map(lambda nd: claude_logged_in(*nd, binary), logins)))


def claude_logins():
    """What claude_limits and claude_signed_out start from, asked once:
    Claude Code's binary, the logins with a profile here, and what Claude
    Code says about each. Nothing with BERTH_USAGE_CLAUDE_LIMITS=0."""
    if os.environ.get("BERTH_USAGE_CLAUDE_LIMITS") == "0":
        return None, [], {}
    binary = claude_binary()
    logins = [(name, d) for name, d in claude_dirs() if claude_account(name, d)["signed_in"]]
    return binary, logins, claude_auth(logins, binary)


def claude_signed_out(state=None):
    """The Claude logins whose profile is here but whose login Claude Code
    has lost: they need signing in again."""
    _, logins, auth = state or claude_logins()
    return [name for name, _ in logins if auth.get(name) is False]


# A read that didn't finish (a timeout, a crash), as opposed to one that
# finished with no limits in it (a login without a plan that has them).
READ_FAILED = "failed"


def read_claude_limits(name, d, binary):
    try:
        return parse_claude_usage(claude_usage_text(name, d, binary))
    except (OSError, ValueError, subprocess.SubprocessError):
        return READ_FAILED


def claude_limits(state=None):
    """Each signed-in Claude login's limits, read with `/usage` at most once
    every CLAUDE_LIMITS_TTL seconds per login, CLAUDE_READERS at a time.
    Off with BERTH_USAGE_CLAUDE_LIMITS=0."""
    binary, logins, auth = state or claude_logins()
    if not binary:
        return []
    from concurrent.futures import ThreadPoolExecutor
    cache = read_json(CLAUDE_LIMITS_CACHE) or {}
    # Who each login is now: a folder signed in to another account since
    # (`/login` again) must not show the last one's limits as its own.
    who = {name: [a["email"], a["org_id"]] for name, d in logins for a in [claude_account(name, d)]}
    # Signed out: its last limits are of a login that is gone. Hung: it would
    # hang /usage too; the last good read stays.
    gone = [name for name, _ in logins if name in cache and (auth.get(name) is False or cache[name].get("who", who[name]) != who[name])]
    for name in gone:
        del cache[name]
    logins = [(name, d) for name, d in logins if auth.get(name) is not False]
    due = [(name, d) for name, d in logins if auth.get(name) != TIMED_OUT and time.time() - (cache.get(name) or {}).get("read", 0) > CLAUDE_LIMITS_TTL]
    if due or gone:
        read = {}
        if due:
            # Each read ends by its own timeout, so waiting for all of them is
            # bounded: a pool left running would hold the script open.
            with ThreadPoolExecutor(max_workers=min(len(due), CLAUDE_READERS)) as pool:
                read = dict(zip([n for n, _ in due], pool.map(lambda nd: read_claude_limits(*nd, binary), due)))
        now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        for name, _ in due:
            hit = cache.get(name) or {}
            if read[name] == READ_FAILED:
                # A read that didn't finish keeps the last good one, as of
                # when it was.
                cache[name] = {**hit, "read": time.time(), "who": who[name]}
            elif read[name] is None:
                # Finished with no limits: the login has none now.
                cache[name] = {"read": time.time(), "who": who[name]}
            else:
                cache[name] = {"read": time.time(), "at": now, "limits": read[name], "who": who[name]}
        tmp = CLAUDE_LIMITS_CACHE.with_name(f"claude-limits.{os.getpid()}.tmp")
        try:
            # It names each login's email: this user's only.
            with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
                f.write(json.dumps(cache))
            tmp.replace(CLAUDE_LIMITS_CACHE)
        except OSError:
            tmp.unlink(missing_ok=True)
    return [{"agent": "claude", "account": name, "at": cache[name]["at"], "limits": cache[name]["limits"]}
            for name, _ in logins if (cache.get(name) or {}).get("limits")]


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
        # Keyed by agent too: Claude Code and Codex each have a "default".
        if s.get("limits") and ((agent, account) not in limits or s["limits_at"] > limits[(agent, account)]["at"]):
            limits[(agent, account)] = {"agent": agent, "account": account, "at": s["limits_at"], "limits": s["limits"]}
    # The limits are extra: whatever goes wrong reading them, the tokens are
    # still reported.
    try:
        claude_state = claude_logins()
    except Exception:
        claude_state = (None, [], {})
    try:
        for l in claude_limits(claude_state):
            limits[("claude", l["account"])] = l
    except Exception:
        pass
    # Who each login is: every box has a "default", so the account name alone
    # can't tell one login read on two boxes from two logins.
    # One email can sign in to two plans (a team seat and a personal Max,
    # say): its organisation tells them apart.
    who = {("claude", n): claude_account(n, d) for n, d in claude_dirs()}
    who.update({("codex", n): codex_account(n, d) for n, d in codex_dirs()})
    for k, l in limits.items():
        a = who.get(k) or {}
        l["email"] = a.get("email")
        l["org"] = a.get("org_id")
    signed_out = []
    try:
        for name in claude_signed_out(claude_state):
            a = who.get(("claude", name)) or {}
            signed_out.append({"agent": "claude", "account": name, "email": a.get("email"), "org": a.get("org_id")})
    except Exception:
        pass

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "days": days, "since": since, "today": dt.date.today().isoformat(), "tz": time.strftime("%Z"),
        "partial": pending > 0, "pending": pending, "files": len(live),
        "columns": ["input", "output", "cache_read", "cache_write"],
        "daily": [[*k, *v] for k, v in sorted(daily.items())],
        "sessions": sorted(sessions.values(), key=lambda r: r["last"] or "", reverse=True),
        "limits": list(limits.values()),
        "signed_out": signed_out,
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
