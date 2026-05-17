#!/usr/bin/env python3
"""pip_cooldown_install.py — install PyPI packages with a release-age cooldown.

pip has no built-in option to refuse freshly published releases (the
`--exclude-newer` flag belongs to uv, not pip). This helper fills that gap:
for every requested package it queries the PyPI JSON API, discards any
version whose *first* file upload happened fewer than COOLDOWN_DAYS days ago,
picks the newest version that survives, and installs that exact version with
`pip install <pkg>==<ver>`.

The point is supply-chain hygiene: a malicious or hijacked release is most
dangerous in the first hours/days after publication, before anyone notices
and yanks it. A few-day cooldown lets that detection happen first.

Configuration:
    PIP_COOLDOWN_DAYS   cooldown window in days (default: 3)

Usage:
    python pip_cooldown_install.py Pillow
    python pip_cooldown_install.py Pillow somepkg otherpkg

Caveat: this pins only the packages you name. Transitive dependencies are
resolved by pip normally and are NOT subject to the cooldown. Pillow has no
runtime dependencies, so the editor install is fully covered. For a guarantee
across the whole dependency tree, use `uv pip install --exclude-newer <date>`
or a curated private index instead.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

COOLDOWN_DAYS = int(os.environ.get("PIP_COOLDOWN_DAYS", "3"))

# packaging is vendored inside pip, so it is available wherever pip is.
try:
    from pip._vendor.packaging.version import Version, InvalidVersion
except Exception:  # pragma: no cover - very old / unusual pip
    try:
        from packaging.version import Version, InvalidVersion
    except Exception:
        Version = None

        class InvalidVersion(Exception):
            pass


def _parse_version(v: str):
    if Version is None:
        return None
    try:
        return Version(v)
    except InvalidVersion:
        return None


def _parse_time(raw: str):
    if not raw:
        return None
    raw = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def newest_eligible(pkg: str, cutoff: datetime):
    """Return (version_str, first_upload_dt) of the newest version whose
    earliest file upload is at or before `cutoff`, or (None, None)."""
    url = f"https://pypi.org/pypi/{pkg}/json"
    req = urllib.request.Request(url, headers={"User-Agent": "pip-cooldown-install/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)

    releases = data.get("releases", {})
    candidates = []
    for ver, files in releases.items():
        live = [f for f in files if not f.get("yanked", False)]
        if not live:
            continue
        pv = _parse_version(ver)
        if pv is None:
            continue
        if pv.is_prerelease or pv.is_devrelease:
            continue
        times = [t for t in (_parse_time(f.get("upload_time_iso_8601")
                                         or f.get("upload_time"))
                             for f in live) if t is not None]
        if not times:
            continue
        first_upload = min(times)
        if first_upload <= cutoff:
            candidates.append((pv, ver, first_upload))

    if not candidates:
        return None, None
    candidates.sort(key=lambda c: c[0])
    _, ver, first_upload = candidates[-1]
    return ver, first_upload


def main(argv) -> int:
    pkgs = argv[1:]
    if not pkgs:
        print("usage: pip_cooldown_install.py <package> [package ...]",
              file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=COOLDOWN_DAYS)
    print(f"Release cooldown: {COOLDOWN_DAYS} day(s) — refusing anything "
          f"published after {cutoff.date()} UTC.\n")

    pinned = []
    for pkg in pkgs:
        try:
            ver, first_upload = newest_eligible(pkg, cutoff)
        except urllib.error.URLError as e:
            print(f"[ERROR] could not reach PyPI for {pkg!r}: {e}",
                  file=sys.stderr)
            return 1
        except Exception as e:
            print(f"[ERROR] failed to resolve {pkg!r}: {e}", file=sys.stderr)
            return 1

        if ver is None:
            print(f"[ERROR] no release of {pkg!r} is at least "
                  f"{COOLDOWN_DAYS} day(s) old — nothing safe to install.",
                  file=sys.stderr)
            return 1

        age_days = (now - first_upload).days
        print(f"  {pkg}: selected {ver}  "
              f"(published {first_upload.date()}, {age_days} day(s) ago)")
        pinned.append(f"{pkg}=={ver}")

    cmd = [sys.executable, "-m", "pip", "install", "--no-input", *pinned]
    print("\nRunning: " + " ".join(cmd) + "\n")
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
