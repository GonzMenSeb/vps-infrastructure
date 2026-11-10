import json
import os
import random
import re
import statistics
import sys

CC = ("cubic", "bbr", "bbr2", "reno", "vegas", "westwood", "htcp")
LOWER_IS_BETTER = {"m3_down_s": True, "m4_first_ms": True, "m4_last_ms": True, "m5_echo_ms": True,
                   "m5b_echo_ms": True, "m6_total_s": True, "m6_login_s": True}
CONTROLS = ("m1_rtt_ms", "m3_up_s", "m5_echo_ms")


def parse_ss(text):
    out = {}
    for tok in text.replace("\t", " ").split():
        if tok in CC and "cc" not in out:
            out["cc"] = tok
    for key in ("rto", "cwnd", "ssthresh", "mss", "pmtu", "bytes_sent", "bytes_retrans", "dsack_dups",
                "data_segs_out", "reord_seen", "minrtt"):
        m = re.search(r"(?:^|\s)%s:([0-9.]+)" % key, text)
        if m:
            out[key] = float(m.group(1))
    m = re.search(r"(?:^|\s)rtt:([0-9.]+)/([0-9.]+)", text)
    if m:
        out["rtt"], out["rttvar"] = float(m.group(1)), float(m.group(2))
    m = re.search(r"(?:^|\s)retrans:([0-9]+)/([0-9]+)", text)
    if m:
        out["retrans_cur"], out["retrans_total"] = int(m.group(1)), int(m.group(2))
    for key in ("pacing_rate", "delivery_rate"):
        m = re.search(r"(?:^|\s)%s ([0-9.]+)([KMG]?)bps" % key, text)
        if m:
            out[key] = float(m.group(1)) * {"": 1, "K": 1e3, "M": 1e6, "G": 1e9}[m.group(2)]
    return out


def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def parse_ping(text):
    t = [float(x) for x in re.findall(r"time=([0-9.]+) ms", text)]
    sent = re.search(r"([0-9]+) packets transmitted", text)
    n = int(sent.group(1)) if sent else len(t)
    if not t:
        return {"n": n, "loss_pct": 100.0}
    return {"n": n, "loss_pct": 100.0 * (n - len(t)) / n, "min": min(t), "p10": pct(t, 10), "p50": pct(t, 50),
            "p90": pct(t, 90), "p95": pct(t, 95), "max": max(t), "sd": statistics.pstdev(t), "samples": t}


def boot_ci(a, b, rounds=10000, seed=0):
    rng = random.Random(seed)
    diffs = []
    for _ in range(rounds):
        ra = [rng.choice(a) for _ in a]
        rb = [rng.choice(b) for _ in b]
        diffs.append(statistics.median(ra) - statistics.median(rb))
    return pct(diffs, 2.5), pct(diffs, 97.5)


def verdict(name, before, after, margin=5.0):
    mb, ma = statistics.median(before), statistics.median(after)
    lo, hi = boot_ci(after, before)
    pc = 100.0 * (ma - mb) / mb if mb else 0.0
    excl = lo > 0 or hi < 0
    if not excl or abs(pc) < margin:
        v = "WITHIN NOISE"
    else:
        better = (ma < mb) if LOWER_IS_BETTER.get(name.split("@")[0], True) else (ma > mb)
        v = "IMPROVED" if better else "REGRESSED"
    return {"metric": name, "before": mb, "after": ma, "delta_pct": pc, "ci": [lo, hi], "verdict": v,
            "n": [len(before), len(after)], "p90": [pct(before, 90), pct(after, 90)]}


def compare(b, a):
    rows, flags = [], []
    mb, ma = b.get("metrics", {}), a.get("metrics", {})
    rb, ra = mb.get("m1_rtt_ms", []), ma.get("m1_rtt_ms", [])
    if rb and ra:
        d = abs(pct(ra, 10) - pct(rb, 10))
        if d > max(10.0, 0.05 * pct(rb, 10)):
            flags.append("PATH CHANGED: TCP deltas are not trustworthy")
    for side, doc in (("before", b), ("after", a)):
        try:
            if float(doc.get("context", {}).get("psi_cpu_avg10_end", 0)) > 50:
                flags.append("NOISY: cpu pressure avg10 above 50 at the end of the %s run" % side)
        except ValueError:
            pass
    sb, sa = b.get("context", {}).get("cpu_stall_fraction"), a.get("context", {}).get("cpu_stall_fraction")
    if sb is not None and sa is not None and abs(sa - sb) > 0.10:
        flags.append("NOISY: cpu stall fraction differs by more than 10 points")
    for name in sorted(set(mb) & set(ma)):
        if len(mb[name]) < 3 or len(ma[name]) < 3:
            continue
        row = verdict(name, mb[name], ma[name])
        if name.split("@")[0] in CONTROLS and row["verdict"] != "WITHIN NOISE":
            flags.append("CONTROL MOVED: %s" % name)
        rows.append(row)
    return {"rows": rows, "flags": flags}


SCRUBS = [
    ("ipv4", re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")),
    ("ipv6", re.compile(r"(?<![0-9A-Za-z:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{0,4}:){1,6}:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)(?![0-9A-Za-z:])")),
    ("hostname", re.compile(r"\bvmi\d+\b")),
    ("fingerprint", re.compile(r"SHA256:[A-Za-z0-9+/]{10,}")),
    ("pubkey", re.compile(r"AAAA[A-Za-z0-9+/]{20,}")),
]
ALLOWED = {"0.0.0.0", "127.0.0.1", "::1"}


def scrub_findings(text):
    found = []
    for name, rx in SCRUBS:
        for m in rx.finditer(text):
            if m.group(0) not in ALLOWED:
                found.append(name)
    for extra in filter(None, os.environ.get("W1_SCRUB_DENY", "").split(",")):
        if extra in text:
            found.append("denied-literal")
    return found


def kv_json(label, text, utc):
    kv = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_.:@/+-]+)=(.*)$", line)
        if m:
            kv[m.group(1)] = m.group(2)
    return {"label": label, "utc": utc, "kv": kv}


def assemble(label, ctx_text, metrics_text, utc):
    ctx = kv_json(label, ctx_text, utc)["kv"]
    metrics = {}
    for line in metrics_text.splitlines():
        name, _, vals = line.partition(":")
        xs = [float(v) for v in vals.split() if re.match(r"^-?[0-9.]+$", v)]
        if name.strip() and xs:
            metrics[name.strip()] = xs
    c0, c1, w = ctx.get("psi_cpu_total_start"), ctx.get("psi_cpu_total_end"), ctx.get("wall_us")
    frac = None
    if c0 and c1 and w and float(w) > 0:
        frac = (float(c1) - float(c0)) / float(w)
    context = dict(ctx)
    if frac is not None:
        context["cpu_stall_fraction"] = frac
    return {"label": label, "utc": utc, "context": context, "metrics": metrics}


def ab_compare(doc):
    arms = doc["arms"]
    base = arms.get("cubic/1")
    rows, flags = [], []
    for arm in sorted(arms):
        if arm == "cubic/1" or not base:
            continue
        for name in sorted(set(base) & set(arms[arm])):
            if len(base[name]) >= 3 and len(arms[arm][name]) >= 3:
                row = verdict(name, base[name], arms[arm][name])
                row["arm"] = arm
                rows.append(row)
    for name in sorted(set(arms.get("bbr/0", {})) & set(arms.get("bbr/1", {}))):
        x, y = arms["bbr/0"][name], arms["bbr/1"][name]
        if len(x) >= 3 and len(y) >= 3 and verdict(name, y, x)["verdict"] != "WITHIN NOISE":
            flags.append("A/B INVALID: null control moved for %s (bbr/0 vs bbr/1)" % name)
    return {"rows": rows, "flags": flags}


def snap_compare(b, a, dry=False):
    kb, ka = b["kv"], a["kv"]
    out, bad = [], []
    if dry:
        same = kb.get("fingerprint") == ka.get("fingerprint") and kb.get("fingerprint")
        return (["DRY RUN WROTE NOTHING" if same else "DRY RUN CHANGED THE HOST: fingerprint differs"], bool(same))
    sel = lambda kv: {k: v for k, v in kv.items() if k.startswith("strict.") or k.startswith("um.")}
    sb, sa = sel(kb), sel(ka)
    for k in sorted(sb):
        if sa.get(k) != sb[k]:
            bad.append("strict set changed: %s %s -> %s" % (k, sb[k], sa.get(k, "absent")))
    added = sorted(k for k in sa if k not in sb)
    if added:
        out.append("NEW infra processes or manager keys (information only): " + ", ".join(added))
    for k in ("oom_kill", "um1000_oom_kill", "um1000_oom_group_kill"):
        if kb.get(k) != ka.get(k):
            bad.append("%s %s -> %s" % (k, kb.get(k), ka.get(k)))
    if ka.get("kernel_kill_lines", "0") not in ("0", ""):
        bad.append("kernel log has %s kill lines since the before snapshot" % ka["kernel_kill_lines"])
    gone = sorted(k for k in kb if k.startswith("claude.") and k not in ka)
    if gone:
        out.append("INCONCLUSIVE, ended without kill evidence: %d claude process(es)" % len(gone))
    out.append("CONTINUITY BROKEN: " + "; ".join(bad) if bad else "INFRA PROCESSES UNTOUCHED")
    return out, not bad


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "parse-ss":
        print(json.dumps(parse_ss(sys.stdin.read())))
    elif cmd == "parse-ping":
        print(json.dumps(parse_ping(sys.stdin.read())))
    elif cmd == "compare":
        res = compare(json.load(open(argv[2])), json.load(open(argv[3])))
        for r in res["rows"]:
            print("%-18s median %.2f -> %.2f (%+.1f%%) p90 %.2f -> %.2f ci=[%.2f,%.2f] n=%d/%d %s" % (
                r["metric"], r["before"], r["after"], r["delta_pct"], r["p90"][0], r["p90"][1], r["ci"][0], r["ci"][1], r["n"][0], r["n"][1], r["verdict"]))
        for f in res["flags"]:
            print("FLAG", f)
        print(json.dumps(res), file=sys.stderr) if "--json" in argv else None
    elif cmd == "kv-json":
        import datetime
        print(json.dumps(kv_json(argv[2], sys.stdin.read(), datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))))
    elif cmd == "snap-compare":
        lines, ok = snap_compare(json.load(open(argv[2])), json.load(open(argv[3])), "--dry" in argv)
        print("\n".join(lines))
        return 0 if ok else 3
    elif cmd == "assemble":
        import datetime
        print(json.dumps(assemble(argv[2], open(argv[3]).read(), open(argv[4]).read(), datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))))
    elif cmd == "ab-compare":
        res = ab_compare(json.load(open(argv[2])))
        for r in res["rows"]:
            print("%-6s %-18s before=%.2f after=%.2f delta=%+.1f%% ci=[%.2f,%.2f] %s" % (
                r["arm"], r["metric"], r["before"], r["after"], r["delta_pct"], r["ci"][0], r["ci"][1], r["verdict"]))
        for f in res["flags"]:
            print("FLAG", f)
    elif cmd == "scrub":
        found = scrub_findings(sys.stdin.read())
        if found:
            print("scrub failed: " + ",".join(sorted(set(found))), file=sys.stderr)
            return 3
    else:
        print("usage: parse-ss | parse-ping | kv-json LABEL | snap-compare B A | compare B A | scrub", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
