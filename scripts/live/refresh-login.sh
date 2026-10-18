#!/usr/bin/env bash
# Fresh CLI login for the session's CLI profile (NEBIUS_PROFILE; lib.sh live_target), so the TTL jobs
# armed next inherit a token that lives about 12 h (an access token is valid for 12 hours:
# https://docs.nebius.com/iam/authorization/access-tokens, mirror .cache/nebius-docs/iam/authorization/access-tokens.md).
# `nebius iam get-access-token` (what scripts/bootstrap-backend.sh calls) returns the CACHED token
# from ~/.nebius/credentials.yaml until it expires, and this CLI (0.12.x) has no logout verb to
# discard it. This script removes ONLY the federation/.../<profile> entry from that file (token and
# expires_at; other entries untouched; rewritten atomically, mode 600, no copy of the old token kept),
# then runs `nebius --profile <profile> iam whoami`, which logs in again in the browser and caches a new
# token. It prints the new expiry, never the token.
# Run it right before run2-0 and run3-2, and whenever a step refuses with "IAM token ... expires".
# Executed: bash refresh-login.sh   (in a real terminal: the login opens a browser)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
step_init refresh-login
need nebius python3
need_tty
live_target || die "no sandbox target (reason above)"
before="$(iam_token_expiry || true)"
say "cached ${LIVE_PROFILE} token expires: $([[ -n "${before}" ]] && nip_utc "${before}" || echo 'no entry')"
if [[ -f "${NEBIUS_CREDS}" ]]; then
  python3 -I - "${NEBIUS_CREDS}" "${LIVE_PROFILE}" <<'PY'
import os, re, sys, tempfile
path, prof = sys.argv[1], sys.argv[2]
out, ind, dropped = [], None, 0
with open(path, encoding="utf-8") as f:
    lines = f.readlines()
for raw in lines:
    line = raw.rstrip("\n")
    lead = len(line) - len(line.lstrip())
    if ind is not None:
        if not line.strip() or lead > ind:
            continue
        ind = None
    m = re.match(r"^\s*(\S.*?):(?:\s+(.*))?$", line)
    if m and line.strip():
        key = m.group(1).strip().strip("\"'")
        if key.startswith("federation/") and key.endswith("/" + prof) and not (m.group(2) or "").strip():
            ind, dropped = lead, dropped + 1
            continue
    out.append(raw)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".credentials.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.writelines(out)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print(f"removed {dropped} cached federation entr{'y' if dropped == 1 else 'ies'} for profile {prof}")
PY
fi
say ">>> nebius --profile ${LIVE_PROFILE} iam whoami   (log in in the browser)"
nebius --profile "${LIVE_PROFILE}" iam whoami --format json >/dev/null || die "login did not complete: rerun bash ${LIVE_DIR}/refresh-login.sh"
after="$(iam_token_expiry)" || die "logged in, but no ${LIVE_PROFILE} federation entry with expires_at was cached"
result_begin
say "profile ${LIVE_PROFILE}: new cached token expires $(nip_utc "${after}") ($(( ( after - $(nip_now) ) / 60 )) min from now)"
say "next: rerun the step that refused (it re-sources the bootstrap, so the new TTL job gets this token)"
