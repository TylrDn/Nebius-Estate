#!/usr/bin/env bash
# Keep a private, redacted temporary report; emit identifying metadata, never source/secret fields.
set -euo pipefail
report="$(mktemp)"
trap 'rm -f "$report"' EXIT
rc=0
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
  gitleaks git --no-banner --redact --report-format=json --report-path="$report" --log-opts=--all . || rc=$?
if ! python3 - "$report" <<'PY'
import json
import sys

try:
    with open(sys.argv[1]) as source:
        findings = json.load(source)
    if not isinstance(findings, list) or any(not isinstance(item, dict) for item in findings):
        raise ValueError("expected a finding list")
except (OSError, ValueError):
    print("Secret scan did not produce a valid report; refusing a clean result.", file=sys.stderr)
    sys.exit(2)
for finding in findings:
    print(json.dumps({key: finding.get(key) for key in
                      ("RuleID", "File", "StartLine", "Commit", "Fingerprint")}))
print(f"Secret scan findings: {len(findings)}")
PY
then
  (( rc != 0 )) || rc=2
fi
exit "$rc"
