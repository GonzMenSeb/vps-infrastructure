import glob
import sys

import yaml

READS = {"command", "shell", "script", "stat", "slurp", "getent", "assert", "debug", "set_fact", "find"}
WRITES = {"copy", "file", "template", "lineinfile", "blockinfile", "systemd", "service", "apt", "uri", "get_url", "unarchive", "cron", "user", "group", "mount", "sysctl", "reboot"}
bad = []


def module_of(task):
    for key in task:
        short = key.split(".")[-1]
        if short in READS or short in WRITES:
            return short
    return ""


def walk(items, path):
    for task in items or []:
        if not isinstance(task, dict):
            continue
        for key in ("block", "rescue", "always"):
            if key in task:
                walk(task[key], path)
        if task.get("check_mode") is False:
            if module_of(task) not in READS or "changed_when" not in task:
                bad.append("%s: %s" % (path, task.get("name")))


for name in sorted(glob.glob(sys.argv[1].rstrip("/") + "/*.yml")):
    with open(name) as handle:
        walk(yaml.safe_load(handle), name)
if bad:
    print("check_mode: false is only for read modules that also set changed_when:\n" + "\n".join(bad))
    sys.exit(1)
