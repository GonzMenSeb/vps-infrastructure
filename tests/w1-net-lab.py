#!/usr/bin/env python3
"""Isolated TCP lab for the w1 net domain: congestion control and idle restart on a 180 ms path.

Run as root from a file, never through `bash -s`. Everything lives in two network namespaces
(w1lab-a, w1lab-b); the default namespace is snapshotted before and after and must not change.
Run it on a workstation (same 6.8 TCP stack). Run it on w1 only with the owner's approval, detached.
"""
import argparse
import json
import os
import random
import re
import shutil
import signal
import socket
import statistics
import struct
import subprocess
import sys
import time

NS = ("w1lab-a", "w1lab-b")
DEV = ("w1lab0", "w1lab1")
SUBNET = (10, 77, 0)
ADDR = tuple("%d.%d.%d.%d" % (*SUBNET, host) for host in (1, 2))
LAB_PREFIX = "%d.%d.%d." % SUBNET
MODULES = ("veth", "sch_netem", "sch_tbf", "tcp_bbr")
INVARIANT_SYSCTLS = (
    "net.ipv4.tcp_congestion_control",
    "net.core.default_qdisc",
    "net.ipv4.tcp_slow_start_after_idle",
    "net.ipv4.tcp_mtu_probing",
    "net.ipv4.ip_forward",
)
PROFILES = {
    "p0": dict(delay="90ms", jitter="", loss="", rate="10mbit", limit=300000, burst="32kb"),
    "p01j": dict(delay="90ms", jitter="10ms", loss="0.1%", rate="10mbit", limit=300000, burst="32kb"),
    "p1": dict(delay="90ms", jitter="", loss="1%", rate="10mbit", limit=300000, burst="32kb"),
    "p6": dict(delay="3.5ms", jitter="", loss="", rate="100mbit", limit=200000, burst="64kb"),
}
M1_ARMS = {"cubic_ssai1": ("cubic", 1), "cubic_ssai0": ("cubic", 0), "bbr": ("bbr", 1)}
BULK_ARMS = {"cubic": ("cubic", 1), "bbr": ("bbr", 1)}
EXPERIMENTS = (
    ("M1", ("p0", "p01j"), M1_ARMS, "warm"),
    ("M3", ("p0", "p01j", "p1"), BULK_ARMS, "bulk"),
    ("M6", ("p6",), BULK_ARMS, "bulk"),
)
TCP_INFO = {"cwnd": 80, "total_retrans": 100, "segs_out": 136, "data_segs_out": 156}


def sh(cmd, check=True):
    return subprocess.run(cmd, shell=True, check=check, capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout


def tcp_info(sock):
    raw = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 256)
    return {k: struct.unpack_from("I", raw, off)[0] for k, off in TCP_INFO.items()}


def cc_of(sock):
    return sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_CONGESTION, 16).split(b"\0")[0].decode()


def child_server(port, cc, mode, a, b):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.setsockopt(socket.IPPROTO_TCP, socket.TCP_CONGESTION, cc.encode())
    listener.bind((ADDR[0], port))
    listener.listen(1)
    listener.settimeout(20)
    conn, _ = listener.accept()
    out = {"cc": cc_of(conn)}
    chunk = b"x" * 65536
    if mode == "bulk":
        end = time.monotonic() + float(a)
        while time.monotonic() < end:
            conn.send(chunk)
        conn.shutdown(socket.SHUT_WR)
        conn.recv(1)
        out.update(tcp_info(conn))
    else:
        warm, idle, sent = int(a), float(b), 0
        while sent < warm:
            sent += conn.send(chunk[: min(len(chunk), warm - sent)])
        conn.recv(1)
        out["cwnd_after_warm"] = tcp_info(conn)["cwnd"]
        time.sleep(idle)
        out["t0"] = time.monotonic()
        conn.sendall(b"y" * 100000)
        conn.recv(1)
    print(json.dumps(out))


def child_client(port, mode, a):
    sock = socket.socket()
    sock.settimeout(30)
    sock.connect((ADDR[0], port))
    if mode == "bulk":
        got, t0 = 0, time.monotonic()
        while True:
            data = sock.recv(1 << 20)
            if not data:
                break
            got += len(data)
        elapsed = time.monotonic() - t0
        sock.send(b"z")
        print(json.dumps({"mbit": got * 8 / elapsed / 1e6}))
    else:
        got = 0
        while got < int(a):
            got += len(sock.recv(1 << 20))
        sock.send(b"w")
        got = 0
        while got < 100000:
            got += len(sock.recv(1 << 20))
        t_last = time.monotonic()
        sock.send(b"z")
        print(json.dumps({"t_last": t_last}))


def psi(path, field):
    with open(path) as fh:
        for line in fh:
            if line.startswith("some"):
                return float(dict(kv.split("=") for kv in line.split()[1:])[field])
    return 0.0


def psi_ok(args):
    cpu, mem = psi("/proc/pressure/cpu", "avg60"), psi("/proc/pressure/memory", "avg10")
    return cpu <= args.psi_cpu_avg60_max and mem <= args.psi_mem_avg10_max, cpu, mem


def default_iface():
    routes = json.loads(sh("ip -j route show default") or "[]")
    return routes[0]["dev"] if routes else ""


def snapshot():
    iface = default_iface()
    snap = {
        "links": sorted(line.split()[0] for line in sh("ip -br link").splitlines()),
        "netns": sh("ip netns list"),
        "listen_tcp": sh("ss -H -ltn"),
        "listen_udp": sh("ss -H -lun"),
        "sysctl": sh("sysctl " + " ".join(INVARIANT_SYSCTLS)),
        "qdisc": sh(f"tc qdisc show dev {iface}") if iface else "",
    }
    return snap


def drift_of(before, after):
    out = [k for k in ("links", "netns", "sysctl", "qdisc") if before[k] != after[k]]
    for key in ("listen_tcp", "listen_udp"):
        added = set(after[key].splitlines()) - set(before[key].splitlines())
        if any(LAB_PREFIX in line or re.search(r":6\d{3}\s", line) for line in added):
            out.append(key)
    return out


def modules_loaded():
    return {line.split()[0] for line in sh("lsmod").splitlines()[1:]}


def leftovers():
    return [n.split()[0] for n in sh("ip netns list").splitlines() if n.startswith("w1lab-")]


def cleanup():
    for ns in NS:
        sh(f"ip netns del {ns}", check=False)


def setup(offloads):
    sh(f"ip netns add {NS[0]}; ip netns add {NS[1]}")
    sh(f"ip link add {DEV[0]} type veth peer name {DEV[1]}")
    for i in (0, 1):
        sh(f"ip link set {DEV[i]} netns {NS[i]}")
        sh(f"ip -n {NS[i]} addr add {ADDR[i]}/24 dev {DEV[i]}")
        sh(f"ip -n {NS[i]} link set lo up; ip -n {NS[i]} link set {DEV[i]} up")
        sh(f"ip netns exec {NS[i]} sysctl -qw net.ipv4.tcp_no_metrics_save=1")
        if offloads:
            sh(f"ip netns exec {NS[i]} ethtool -K {DEV[i]} tso off gso off gro off")


def shape(profile):
    for i in (0, 1):
        sh(f"ip netns exec {NS[i]} tc qdisc del dev {DEV[i]} root", check=False)
        jitter = f" {profile['jitter']}" if profile["jitter"] else ""
        loss = f" loss {profile['loss']}" if profile["loss"] and i == 0 else ""
        sh(f"ip netns exec {NS[i]} tc qdisc add dev {DEV[i]} root handle 1: netem delay {profile['delay']}{jitter}{loss} limit 5000")
        sh(f"ip netns exec {NS[i]} tc qdisc add dev {DEV[i]} parent 1:1 handle 10: tbf rate {profile['rate']} burst {profile['burst']} limit {profile['limit']}")
    shown = sh(f"ip netns exec {NS[0]} tc qdisc show dev {DEV[0]}")
    wanted = [f"delay {profile['delay']}", f"rate {profile['rate'].replace('mbit', 'Mbit')}"]
    if profile["loss"]:
        wanted.append(f"loss {profile['loss']}")
    missing = [w for w in wanted if w not in shown]
    if missing:
        raise SystemExit(f"qdisc readback lacks {missing}: {shown}")


def trial(cc, ssai, mode, a, b, port):
    sh(f"ip netns exec {NS[0]} sysctl -qw net.ipv4.tcp_slow_start_after_idle={ssai}")
    got = sh(f"ip netns exec {NS[0]} sysctl -n net.ipv4.tcp_slow_start_after_idle").strip()
    if got != str(ssai):
        raise SystemExit(f"namespace sysctl readback {got} != {ssai}")
    for ns in NS:
        sh(f"ip netns exec {ns} ip tcp_metrics flush", check=False)
    me = os.path.abspath(__file__)
    srv = subprocess.Popen(
        f"ip netns exec {NS[0]} python3 {me} --child server {port} {cc} {mode} {a} {b}",
        shell=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
    time.sleep(0.4)
    try:
        cli = subprocess.run(
            f"ip netns exec {NS[1]} python3 {me} --child client {port} {mode} {a}",
            shell=True, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90)
        sout, _ = srv.communicate(timeout=90)
    except subprocess.TimeoutExpired:
        srv.kill()
        raise
    return json.loads(sout), json.loads(cli.stdout)


def plan(args):
    reps = {"M1": args.m1_reps, "M3": args.m3_reps, "M6": args.m3_reps}
    secs = {"M1": 9, "M3": args.bulk_secs + 3, "M6": args.bulk_secs + 3}
    cells = []
    for name, profiles, arms, mode in EXPERIMENTS:
        for prof in profiles:
            cells.append((name, prof, arms, mode, reps[name], secs[name]))
    return cells


def run(args):
    cells = plan(args)
    if args.dry_run:
        total = 0
        for name, prof, arms, mode, reps, secs in cells:
            print(f"{name} {prof} arms={list(arms)} reps={reps} ~{len(arms) * reps * secs}s")
            total += len(arms) * reps * secs
        print(f"estimated total {total // 60} min; ethtool={'yes' if shutil.which('ethtool') else 'no'}; seed={args.seed}")
        return 0
    if os.geteuid() != 0:
        raise SystemExit("run as root")
    for tool in ("ip", "tc", "ss", "sysctl"):
        if not shutil.which(tool):
            raise SystemExit(f"missing {tool}")
    if leftovers():
        raise SystemExit(f"namespaces left over: {leftovers()}; run --cleanup")
    ok, cpu, mem = psi_ok(args)
    if not ok:
        raise SystemExit(f"pressure gate: cpu avg60 {cpu}, memory avg10 {mem}")
    offloads = bool(shutil.which("ethtool"))
    before_mods = modules_loaded()
    for mod in MODULES:
        sh(f"modprobe {mod}")
    loaded_by_lab = sorted(modules_loaded() - before_mods)
    before = snapshot()
    rng = random.Random(args.seed)
    results, invalid, port = {}, 0, 6000
    out = open(args.out, "w")
    out.write(json.dumps({"kind": "run", "seed": args.seed, "kernel": os.uname().release, "offloads_off": offloads,
                          "modules_loaded_by_lab": loaded_by_lab, "psi_start": [cpu, mem]}) + "\n")
    try:
        setup(offloads)
        for name, prof, arms, mode, reps, secs in cells:
            shape(PROFILES[prof])
            order = [(arm, rep) for rep in range(reps) for arm in arms]
            rng.shuffle(order)
            for arm, rep in order:
                ok, cpu, mem = psi_ok(args)
                cc, ssai = arms[arm]
                port += 1
                if mode == "warm":
                    s, c = trial(cc, ssai, "warm", args.warm_bytes, 2, port)
                    value, unit = (c["t_last"] - s["t0"]) * 1000, "ms"
                    valid = s["cwnd_after_warm"] >= 20 and s["cc"] == cc
                    extra = {"cwnd_after_warm": s["cwnd_after_warm"]}
                else:
                    s, c = trial(cc, ssai, "bulk", args.bulk_secs, 0, port)
                    value, unit = c["mbit"], "Mbit/s"
                    valid = s["cc"] == cc
                    extra = {"retrans_pct": round(100 * s["total_retrans"] / max(1, s["data_segs_out"]), 2)}
                valid = valid and ok
                invalid += 0 if valid else 1
                row = {"kind": "trial", "exp": name, "profile": prof, "arm": arm, "rep": rep, "cc": s["cc"], "ssai": ssai,
                       "value": round(value, 2), "unit": unit, "valid": valid, "psi": [cpu, mem], **extra}
                out.write(json.dumps(row) + "\n")
                out.flush()
                if valid:
                    results.setdefault((name, prof, arm), []).append(value)
    finally:
        cleanup()
        after = snapshot()
        out.close()
    drift = drift_of(before, after)
    report(args, results, invalid, offloads, loaded_by_lab, drift)
    return 1 if drift else 0


def med(results, key):
    vals = results.get(key, [])
    return statistics.median(vals) if vals else None


def report(args, results, invalid, offloads, loaded_by_lab, drift):
    print(f"\nresults ({args.out}); invalid trials: {invalid}; offloads_off: {offloads}; modules loaded by the lab: {loaded_by_lab or 'none'}")
    print("0% profiles still drop at the 300 KB shaper queue: read them as shallow buffer, not lossless")
    print(f"{'exp':<4} {'profile':<6} {'arm':<12} {'n':>2} {'median':>9} {'min':>9} {'max':>9}")
    for (name, prof, arm), vals in sorted(results.items()):
        print(f"{name:<4} {prof:<6} {arm:<12} {len(vals):>2} {statistics.median(vals):>9.1f} {min(vals):>9.1f} {max(vals):>9.1f}")
    print("host invariants:", "UNCHANGED" if not drift else f"CHANGED {drift}")
    m1 = {p: (med(results, ("M1", p, "cubic_ssai1")), med(results, ("M1", p, "cubic_ssai0")), med(results, ("M1", p, "bbr")))
          for p in ("p0", "p01j")}
    m3 = {p: (med(results, ("M3", p, "cubic")), med(results, ("M3", p, "bbr"))) for p in ("p0", "p01j", "p1")}
    m6 = (med(results, ("M6", "p6", "cubic")), med(results, ("M6", "p6", "bbr")))
    enough = (args.m1_reps >= 5 and args.m3_reps >= 3 and args.bulk_secs >= 10 and offloads
              and all(v is not None for t in m1.values() for v in t) and all(v is not None for t in m3.values() for v in t)
              and all(v is not None for v in m6))
    if not enough:
        print("GATES NOT EVALUATED: need m1-reps>=5, m3-reps>=3, bulk-secs>=10, ethtool present and every cell valid")
        return
    g_loss = m3["p1"][1] >= 1.5 * m3["p1"][0] and m3["p01j"][1] >= 0.9 * m3["p01j"][0]
    g_m1 = all(m1[p][2] <= m1[p][0] - 100 and m1[p][2] <= 1.3 * m1[p][1] for p in m1)
    g_m6 = m6[1] >= 0.9 * m6[0]
    g_ssai = any(m1[p][0] - m1[p][1] >= 100 for p in m1)
    print(f"GATE bbr_loss  {'PASS' if g_loss else 'FAIL'}  p1 bbr/cubic {m3['p1'][1]:.1f}/{m3['p1'][0]:.1f} Mbit/s, p01j {m3['p01j'][1]:.1f}/{m3['p01j'][0]:.1f}")
    print(f"GATE bbr_idle  {'PASS' if g_m1 else 'FAIL'}  burst ms ssai1/ssai0/bbr " + ", ".join(f"{p}: {m1[p][0]:.0f}/{m1[p][1]:.0f}/{m1[p][2]:.0f}" for p in m1))
    print(f"GATE bbr_fast  {'PASS' if g_m6 else 'FAIL'}  7 ms path bbr/cubic {m6[1]:.1f}/{m6[0]:.1f} Mbit/s")
    if g_loss and g_m1 and g_m6:
        print("DEFAULT agent_host_net_congestion_control=bbr agent_host_net_slow_start_after_idle=1")
    else:
        print(f"DEFAULT agent_host_net_congestion_control=cubic agent_host_net_slow_start_after_idle={0 if g_ssai else 1}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--child", nargs="+", help=argparse.SUPPRESS)
    ap.add_argument("--cleanup", action="store_true", help="delete the w1lab-* namespaces and exit")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit")
    ap.add_argument("--quick", action="store_true", help="2 reps, 4 s bulk runs, gates not evaluated")
    ap.add_argument("--detach", action="store_true", help="re-run under systemd-run with CPU, memory and time limits")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--m1-reps", type=int, default=5)
    ap.add_argument("--m3-reps", type=int, default=3)
    ap.add_argument("--bulk-secs", type=int, default=10)
    ap.add_argument("--warm-bytes", type=int, default=3000000)
    ap.add_argument("--psi-cpu-avg60-max", type=float, default=25.0)
    ap.add_argument("--psi-mem-avg10-max", type=float, default=1.0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    if args.child:
        role, rest = args.child[0], args.child[1:]
        if role == "server":
            child_server(int(rest[0]), rest[1], rest[2], rest[3], rest[4])
        else:
            child_client(int(rest[0]), rest[1], rest[2])
        return 0
    if args.cleanup:
        if os.geteuid() != 0:
            raise SystemExit("run as root")
        cleanup()
        print("namespaces left:", leftovers() or "none")
        return 0
    if args.quick:
        args.m1_reps, args.m3_reps, args.bulk_secs = 2, 1, 4
    args.out = args.out or os.path.join(os.environ.get("TMPDIR", "/tmp"), f"w1-net-lab-{int(time.time())}.jsonl")
    if args.detach:
        me = os.path.abspath(__file__)
        passthrough = [a for a in sys.argv[1:] if a != "--detach"]
        if "--out" not in passthrough:
            passthrough += ["--out", args.out]
        cmd = ["systemd-run", "--collect", "--unit=w1-net-lab", "-p", "CPUWeight=10", "-p", "MemoryMax=512M", "-p", "TasksMax=256",
               "-p", "RuntimeMaxSec=3600", "-p", "Nice=19", "-p", f"ExecStopPost={sys.executable} {me} --cleanup",
               sys.executable, me, *passthrough]
        print(" ".join(cmd))
        return subprocess.call(cmd)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(130))
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
