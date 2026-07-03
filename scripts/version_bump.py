#!/usr/bin/env python3
"""Version-bump / build-snapshot helper for the culflasher web tool.

Web analogue of the embedded `version_bump.py` (TCM32): there is no compiler,
so the "build" step is the *deploy*.  Run this manually to checkpoint work, or
let scripts/deploy.sh call it before publishing.

On each run:
  1. If the working tree is dirty, snapshot it (`git add -A; git commit`) under
     the *previous* version label — a lauffähiger Rückkehrpunkt.
  2. Increment build_number.txt.
  3. Regenerate version.js (imported by index.html for the visible banner).

Manual fields:
  - version.txt        — MAJOR.MINOR (one line, e.g. `1.0`). Bump by hand at a
                         meaningful project phase.
  - build_number.txt   — auto-incremented; do not edit unless resetting.

Touches only this project tree. No global git config is modified; commits use
whatever git already has configured. NO Co-Author trailer (project policy).

NB: the repo lives on NFS — all writes go through _atomic_write (tmp + fsync +
atomic replace + dir-fsync), and the commit is retried on the transient
NFS/NUL-byte flake, same as the embedded reference.
"""

import datetime
import os
import subprocess
import time

PROJECT_DIR  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_FILE = os.path.join(PROJECT_DIR, "version.txt")
BUILD_FILE   = os.path.join(PROJECT_DIR, "build_number.txt")
VERSION_JS   = os.path.join(PROJECT_DIR, "version.js")


def _read_parsed(path, parse, tries=6):
    """NFS-robuster Read+Parse: liest neu bei NUL-Byte (halb geschriebene
    Seite), OSError oder Parse-ValueError; scheitert danach LAUT. Gegenstück
    zum atomic-write — der NFS-Flake kann einem Leser eine NUL-gepaddete
    Datei zeigen, die int() sonst mit ValueError abbricht (str.strip()
    entfernt keine inneren NULs)."""
    last = None
    for attempt in range(tries):
        try:
            with open(path, "rb") as f:
                raw = f.read()
            if b"\x00" in raw:
                raise ValueError("NUL-Byte (NFS-Transient)")
            return parse(raw.decode("utf-8", "strict").strip())
        except (OSError, ValueError) as e:
            last = e
            time.sleep(0.2 * (attempt + 1))
    raise RuntimeError(f"{path}: nicht sauber lesbar nach {tries} Versuchen ({last})")


def _read_version():
    def parse(v):
        parts = v.split(".")
        if len(parts) != 2:
            raise ValueError(f"must be MAJOR.MINOR — got {v!r}")
        return int(parts[0]), int(parts[1])
    return _read_parsed(VERSION_FILE, parse)


def _read_build():
    if not os.path.exists(BUILD_FILE):
        return 0
    return _read_parsed(BUILD_FILE, lambda v: int(v or "0"))


def _atomic_write(path, content):
    """NFS-safe write: tmp + fsync(file) + atomic replace + fsync(dir)."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def _write_build(n):
    _atomic_write(BUILD_FILE, f"{n}\n")


def _is_git_repo():
    return os.path.isdir(os.path.join(PROJECT_DIR, ".git"))


def _git_run(args, capture=False):
    # fsync flags: .git on NFS can otherwise hand a reader NUL-padded objects.
    base = ["git", "-c", "core.fsync=loose-object", "-c", "core.fsyncMethod=fsync"]
    return subprocess.run(base + args, cwd=PROJECT_DIR,
                          capture_output=capture, text=True, check=False)


def _git_has_changes():
    r = _git_run(["status", "--porcelain"], capture=True)
    return bool(r.stdout.strip())


def _git_autocommit(prev_version_str):
    if not _git_has_changes():
        return False
    last_add = ""
    for attempt in range(6):
        add = _git_run(["add", "-A"], capture=True)
        if add.returncode == 0:
            break
        last_add = ((add.stderr or "") + (add.stdout or "")).strip()
        # nur den NFS/NUL-Transienten retryen, echte Fehler sofort melden
        if "NUL byte" not in last_add and "failed to write" not in last_add:
            print(f"[version_bump] git add failed (rc={add.returncode}); skip commit")
            return False
        time.sleep(0.25 * (attempt + 1))
    else:
        print(f"[version_bump] git add failed after retries: {last_add}")
        return False
    msg = f"build snapshot v{prev_version_str}"
    last = ""
    for attempt in range(8):
        cm = _git_run(["commit", "-m", msg], capture=True)
        if cm.returncode == 0:
            return True
        last = ((cm.stderr or "") + (cm.stdout or "")).strip()
        transient = "NUL byte" in last or "failed to write commit object" in last
        if not transient:
            break
        time.sleep(0.25 * (attempt + 1))
    print(f"[version_bump] git commit skipped: {last}")
    return False


def main():
    major, minor = _read_version()
    prev_build = _read_build()
    new_build  = prev_build + 1
    prev_version = f"{major}.{minor}.{prev_build}"
    new_version  = f"{major}.{minor}.{new_build}"

    # 1: snapshot working tree under the *previous* version label.
    if _is_git_repo():
        if _git_autocommit(prev_version):
            print(f"[version_bump] git snapshot committed @ v{prev_version}")
    else:
        print("[version_bump] not a git repo — skipping snapshot")

    # 2: bump build counter.
    _write_build(new_build)

    # 3: regenerate version.js.
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    js = (
        "// AUTO-GENERATED by scripts/version_bump.py — do not edit by hand.\n"
        "// Manual fields: version.txt (MAJOR.MINOR), build_number.txt (BUILD).\n"
        f'export const VERSION = "{new_version}";\n'
        f'export const BUILD_DATE = "{now}";\n'
    )
    _atomic_write(VERSION_JS, js)
    print(f"[version_bump] culflasher v{new_version}  ({now})")


if __name__ == "__main__":
    main()
