#!/usr/bin/env bash
# Gate for an apply that carries no nip-ttl-expires label (make soperator-apply).
#
#   scripts/ttl-armed.sh --stage <stage> --stack <stack>
#
# The upstream Soperator recipe labels nothing, so modules/stage-policy never sees a TTL for it. In a
# stage whose policy has require_ttl_label (platform/stages.yaml), this exits 0 only while the root's
# safety-net job from `make ttl-teardown` is running: terraform/live/<stage>/<stack>/.terraform/ttl-teardown.pid
# names a live process whose command contains ttl-teardown. It exits 1 otherwise, and 0 in a stage
# without require_ttl_label. Read-only: it starts and stops nothing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

stage="" stack=""
while (( $# )); do
  case "$1" in
    --stage) stage="$2"; shift 2 ;;
    --stack) stack="$2"; shift 2 ;;
    *) echo "usage: $0 --stage <stage> --stack <stack>" >&2; exit 2 ;;
  esac
done
[[ -n "${stage}" && -n "${stack}" ]] || { echo "usage: $0 --stage <stage> --stack <stack>" >&2; exit 2; }

required="$(python3 scripts/render-live-roots.py --policy "${stage}" require_ttl_label)" \
  || { echo "Refusing: no require_ttl_label for stage '${stage}' in platform/stages.yaml" >&2; exit 1; }
[[ "${required}" == true ]] || exit 0

# The command line of a live pid: ps where it exists (macOS, most hosts), else /proc (the toolbox
# image has no procps). Nothing printed for a dead pid, or when neither is available (refused).
cmdline() {
  if command -v ps >/dev/null; then ps -p "$1" -o command= 2>/dev/null || true
  elif [[ -r "/proc/$1/cmdline" ]]; then tr '\0' ' ' < "/proc/$1/cmdline"
  fi
}
pidfile="terraform/live/${stage}/${stack}/.terraform/ttl-teardown.pid"
pid="$(cat "${pidfile}" 2>/dev/null || true)"
if [[ "${pid}" =~ ^[0-9]+$ ]] && cmdline "${pid}" | grep -q ttl-teardown; then
  echo "TTL armed for ${stage}/${stack}: ttl-teardown job ${pid} (log $(dirname "${pidfile}")/ttl-teardown.log)"
  exit 0
fi
echo "Refusing: ${stage} requires a TTL (require_ttl_label) and ${stack} carries no nip-ttl-expires label;" \
  "no ttl-teardown job is running (${pidfile}). Arm it first:" \
  "make ttl-teardown STAGE=${stage} STACK=${stack} TTL=<YYYY-MM-DDTHH:MM:SSZ> CONFIRM=yes" >&2
exit 1
