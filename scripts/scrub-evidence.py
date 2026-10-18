#!/usr/bin/env python3
"""Replace Nebius resource ids in a live run's output with placeholders before it is committed.

Evidence is committed (docs/evidence/README.md "What is committed"), real resource ids are not
(the repository rules). A run's `results/*.json` and logs carry ids in a few shapes:

  typed id         computeinstance-e00…, mk8scluster-e00…, registry-e00…    -> computeinstance-<id>
  name + id        a kube context `nebius-mk8s-<cluster name>-<cluster id>`  -> …-<cluster name>-<id>
                   MSP hosts `mlflow-<id>.backbone-<id>.msp.<region>…`, bucket names that end in a
                   cut of the project id (`nip-sandbox-checkpoints-e00…`)
  bare id          the registry path segment `cr.<region>.nebius.cloud/<registry id without prefix>/`
  state bucket     `tfstate-<stage…>-<12 hex>` (scripts/bootstrap-backend.sh)  -> tfstate-<stage…>-<hex>
  other context    a JSON `"context"` that is not a `nebius-mk8s-…` kube context: the step ran
                   while kubectl pointed elsewhere, and that name is not ours to publish
                                                                              -> <unrelated-context>

An id is `<route><random>`: a letter and two digits (`e00` in eu-north1; the route codes of other
regions are not documented in the cached docs, so the letter is not fixed) then lowercase letters
and digits. Image digests (`sha256:…`), versions and timestamps are left alone.

Usage:
  scripts/scrub-evidence.py FILE...            print the scrubbed text of each file to stdout
  scripts/scrub-evidence.py --write DIR FILE…  write each scrubbed file to DIR/<basename>
  scripts/scrub-evidence.py --check FILE...    exit 1 if any file still carries an id; prints
                                               file:line and the kind of match, never the id
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROUTE = r"[a-z][0-9]{2}"
# <name>-<id>: the id after a hyphen; at least 9 characters after the route (a bucket suffix cut
# from the project id is 12 in all). Not preceded by `:` so a digest such as `sha256:e00…` stays.
TYPED = re.compile(rf"(?<![0-9A-Za-z:])([a-z][a-z0-9]*(?:-[a-z0-9]+)*?)-({ROUTE}[0-9a-z]{{9,}})\b")
# A bare id (registry path segment): longer, to keep ordinary words and versions out.
BARE = re.compile(rf"(?<![0-9A-Za-z:./-])({ROUTE}[0-9a-z]{{12,}})\b|(?<=nebius\.cloud/)({ROUTE}[0-9a-z]{{9,}})\b")
STATE = re.compile(r"\b(tfstate-[a-z0-9-]*?)-([0-9a-f]{12})\b")
# The kube context a step recorded (tests/validate/*.sh write `"context": "<current-context>"`).
# A session cluster's context is `nebius-mk8s-<cluster name>-<cluster id>` as written by `nebius mk8s
# cluster get-credentials` in the 2026-10-12 runs; the cached docs (kubernetes/connect.md) do not
# state the naming, so it is observed, not documented. Anything else, unless already a placeholder or
# lib.sh's `none`, is someone else's context.
CONTEXT = re.compile(r'("context"\s*:\s*")(?!nebius-mk8s-|<|none")([^"]*)(")')


def _looks_like_id(token: str) -> bool:
    # A git or image hash (hex only, e.g. a pinned revision `a09a3545…`) is not an id; an id's
    # alphabet runs past `f`, so 15+ characters of hex alone are a hash, not a Nebius id.
    return not re.fullmatch(r"[0-9a-f]+", token)


def scrub(text: str) -> str:
    text = STATE.sub(lambda m: f"{m.group(1)}-<hex>", text)
    text = CONTEXT.sub(lambda m: f"{m.group(1)}<unrelated-context>{m.group(3)}", text)
    text = TYPED.sub(lambda m: f"{m.group(1)}-<id>" if _looks_like_id(m.group(2)) else m.group(0), text)
    return BARE.sub(lambda m: "<id>" if _looks_like_id(m.group(1) or m.group(2)) else m.group(0), text)


def findings(text: str) -> list[tuple[int, str]]:
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if STATE.search(line):
            out.append((n, "state bucket suffix"))
        if CONTEXT.search(line):
            out.append((n, "kube context outside the session cluster"))
        for m in TYPED.finditer(line):
            if _looks_like_id(m.group(2)):
                out.append((n, f"id after '{m.group(1)}-'"))
        for m in BARE.finditer(line):
            if _looks_like_id(m.group(1) or m.group(2)):
                out.append((n, "bare id"))
    return out


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("files", nargs="+", type=Path)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--check", action="store_true", help="fail if any file still carries an id")
    g.add_argument("--write", type=Path, metavar="DIR", help="write scrubbed copies into DIR")
    a = p.parse_args(argv)
    bad = 0
    for f in a.files:
        text = f.read_text(encoding="utf-8", errors="replace")
        if a.check:
            for n, what in findings(text):
                print(f"{f}:{n}: resource id ({what}); scrub it with scripts/scrub-evidence.py", file=sys.stderr)
                bad += 1
        elif a.write:
            a.write.mkdir(parents=True, exist_ok=True)
            (a.write / f.name).write_text(scrub(text), encoding="utf-8")
        else:
            sys.stdout.write(scrub(text))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
