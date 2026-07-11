#!/usr/bin/env python3
"""Hardened calibration dispatcher for temporary Fly performance machines.

Lifecycle (every step verified, everything bounded, machine ALWAYS destroyed):
  1. create performance-1x machine whose PID1 waits for /tmp/go then runs the
     harness ITSELF — work owned by PID1 survives SSH session teardown
     (fly ssh kills the session's process tree on disconnect; nohup doesn't help)
  2. reachability gate: SSH echo must answer (retries) — zombies caught here
  3. upload engine tarball + runner script, verify staged
  4. touch /tmp/go, then verify the harness PROCESS is running
     (NOT log bytes: the harness prints nothing until completion)
  5. poll every 60s: done-marker → fetch; process dead → fail; hard time cap
  6. finally: destroy --force (crash-safe; loud if destroy fails)

Usage: cal_run.py --name cal-x --tar engine.tar.gz --args "--n 150" [--max-min 90]
"""
import argparse, subprocess, sys, time

APP = "football-manager---594q"
IMG = "registry.fly.io/football-manager---594q:deployment-01KX67418NG0HHA07MRYND4NMC"
ALIVE = "cat /proc/[0-9]*/cmdline 2>/dev/null | tr \\0 \\n | grep -c harness || true"


def sh(cmd, timeout=60):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)


def log(msg):
    print(f"[cal-run {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--tar", required=True)
    ap.add_argument("--args", default="--n 150")
    ap.add_argument("--max-min", type=float, default=90)
    a = ap.parse_args()

    machine = None

    def ssh(remote, timeout=60):
        return sh(f'fly ssh console -a {APP} --machine {machine} -C "sh -c \'{remote}\'"', timeout)

    try:
        pid1 = "while [ ! -f /tmp/go ]; do sleep 2; done; sh /tmp/cal-runner.sh; sleep infinity"
        log(f"creating {a.name} (performance-1x)…")
        r = sh(f"fly machine run {IMG} --vm-size performance-1x --name {a.name} -a {APP} --region cdg -- sh -c '{pid1}'", timeout=180)
        for line in r.stdout.splitlines():
            if "Machine ID" in line:
                machine = line.split(":")[1].strip()
        if not machine:
            log(f"CREATE FAILED\n{r.stdout}\n{r.stderr}")
            return 1
        log(f"created {machine}")

        for attempt in range(6):
            try:
                if "reachable" in ssh("echo reachable", 45).stdout:
                    break
            except subprocess.TimeoutExpired:
                pass
            log(f"not reachable yet ({attempt + 1}/6)")
            time.sleep(20)
        else:
            log("REACHABILITY FAILED — zombie machine, aborting")
            return 1
        log("reachable ✓")

        r = sh(f"fly ssh sftp put {a.tar} /tmp/engine-cal.tar.gz -a {APP} --machine {machine}", timeout=300)
        if "uploaded" not in (r.stdout + r.stderr):
            log(f"UPLOAD FAILED\n{r.stdout}\n{r.stderr}")
            return 1
        with open("/tmp/cal-runner-local.sh", "w") as f:
            f.write("#!/bin/sh\nmkdir -p /tmp/engine-cal\ntar xzf /tmp/engine-cal.tar.gz -C /tmp/engine-cal 2>/dev/null\n"
                    f"cd /tmp/engine-cal\nENGINE=agent node stat-harness.ts {a.args} > /tmp/run.log 2>&1\necho done > /tmp/run.done\n")
        r = sh(f"fly ssh sftp put /tmp/cal-runner-local.sh /tmp/cal-runner.sh -a {APP} --machine {machine}", timeout=90)
        if "uploaded" not in (r.stdout + r.stderr):
            log(f"RUNNER UPLOAD FAILED\n{r.stdout}\n{r.stderr}")
            return 1
        if "flagged" not in ssh("touch /tmp/go && echo flagged", 45).stdout:
            log("DISPATCH FAILED")
            return 1
        log("dispatched ✓ (PID1-owned)")

        time.sleep(15)
        started = False
        for _ in range(8):
            out = ssh(ALIVE, 45).stdout.strip().splitlines()
            if out and out[-1].isdigit() and int(out[-1]) > 0:
                started = True
                break
            time.sleep(10)
        if not started:
            log("START VERIFICATION FAILED — no harness process within ~95s; state:")
            print(ssh("ls -la /tmp/go /tmp/run.log /tmp/run.done 2>&1; tail -5 /tmp/run.log 2>/dev/null", 45).stdout)
            return 1
        log(f"harness process running ✓ — polling (hard cap {a.max_min}min)")

        t0 = time.time()
        while True:
            time.sleep(60)
            mins = (time.time() - t0) / 60
            if mins > a.max_min:
                log(f"TIMEOUT — exceeded {a.max_min}min cap; tail:")
                print(ssh("tail -5 /tmp/run.log 2>/dev/null", 45).stdout)
                return 1
            out = ssh(f"ls /tmp/run.done 2>/dev/null; {ALIVE}", 45).stdout.strip().splitlines()
            done = any("run.done" in l for l in out)
            alive = bool(out) and out[-1].isdigit() and int(out[-1]) > 0
            if done:
                log(f"run complete ✓ in {mins:.1f}min — fetching results")
                res = ssh("sed -n 1p /tmp/run.log; grep -E \"sweep|FAIL|pass, \" /tmp/run.log | grep -v \"^[[]\"", 90)
                if res.stdout.strip():
                    print(res.stdout)
                else:
                    log("filtered fetch empty — raw log tail follows (fetch quoting or empty run):")
                    print(ssh("wc -l /tmp/run.log; tail -40 /tmp/run.log", 90).stdout)
                return 0
            if not alive:
                log("PROCESS DIED without done-marker; log tail:")
                print(ssh("tail -10 /tmp/run.log 2>/dev/null", 45).stdout)
                return 1
            log(f"alive… ({mins:.0f}min)")
    except Exception as e:
        log(f"PIPELINE ERROR: {e}")
        return 1
    finally:
        if machine:
            log(f"destroying {machine}…")
            try:
                r = sh(f"fly machine destroy {machine} --force -a {APP}", timeout=120)
                log("destroyed ✓" if r.returncode == 0 else f"DESTROY FAILED — destroy {machine} manually!\n{r.stderr}")
            except Exception as e:
                log(f"DESTROY FAILED — destroy {machine} manually! ({e})")


if __name__ == "__main__":
    sys.exit(main())
