#!/usr/bin/env bash
# Usage: invoked by the lab harness, which exports LAB_CHDIR (the assembled Terraform dir) and LAB_STATE (its state file).
# Lab 04: find the Soperator login node, deliver the vendored quickcheck tests, run hello.sh on the CPU worker,
# and save the Slurm view of the cluster to labs/04-soperator/results/<UTC timestamp>.md. The report is written even
# when a step fails (with the failing exit code and the output so far); run.sh then exits with that code.
# The recipe has no outputs.tf, so the login IP comes from state (soperator/README.md "Get Cluster Connection Details").
set -euo pipefail
LAB=04-soperator
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
KEY="$HOME/.ssh/nebius_ed25519"
QUICKCHECK="$ROOT/vendor/nebius-solutions-library/soperator/test/quickcheck"
REMOTE_DIR=/opt/slurm-test/quickcheck   # soperator/test/common/env.sh TEST_QUICKCHECK_DIR
: "${LAB_CHDIR:?run via the lab harness (LAB_CHDIR is the assembled Terraform dir)}"

DEST="$ROOT/labs/$LAB/results"
REPORT="$DEST/$(date -u +%Y%m%dT%H%M%SZ).md"
OUT=$(mktemp)
IP=""
# stdout AND stderr of every remote step are tee'd into $OUT, so a failed report says why.
# EXIT trap: always leave results/<ts>.md (a failed run on billed infrastructure is still evidence), then exit rc.
write_report() {
  local rc=$?
  set +e   # a failing line in here must not cut the report short
  mkdir -p "$DEST"
  {
    echo "# Lab 04 soperator quickcheck, $(date -u +%Y-%m-%dT%H:%MZ)"
    echo
    echo "CPU variant (cpu-d3 8vcpu-32gb worker). Login node ${IP:-unknown}. \`sbatch --gpus-per-node=0 --mem=4G hello.sh\`."
    echo
    if (( rc == 0 )); then echo "Outcome: ✅ success (exit 0)."; else echo "Outcome: ❌ failed (exit $rc); output up to the failing step below."; fi
    echo
    echo '```'
    cat "$OUT"
    echo '```'
  } > "$REPORT"
  rm -f "$OUT"
  echo "report: $REPORT"
  exit "$rc"
}
trap write_report EXIT
fail() { echo "$*" | tee -a "$OUT" >&2; exit 1; }

[[ -d $QUICKCHECK ]] || fail "missing $QUICKCHECK: run make vendor"

# Watchdog: SIGALRM survives exec, so the command is killed after N seconds. Portable (macOS has no timeout(1)).
bounded() { perl -e 'alarm shift; exec @ARGV or die "exec $ARGV[0]: $!\n"' "$@"; }

IP=$(bounded 120 terraform -chdir="$LAB_CHDIR" state show -no-color module.login_script.terraform_data.lb_service_ip \
  | grep 'input' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
[[ -n $IP ]] || fail "no login IP in state (module.login_script.terraform_data.lb_service_ip): is the lab up?"
echo "Slurm login node: $IP" | tee -a "$OUT"

mkdir -p "$ROOT/.cache/labs/$LAB"
# Fresh per run: a recycled public IP with a new host key would otherwise fail every SSH wait while the VM bills.
KNOWN_HOSTS="$ROOT/.cache/labs/$LAB/known_hosts"
rm -f "$KNOWN_HOSTS"
# Every wait is bounded: a hung step would keep `demo` from reaching `down` while 6 VMs bill.
OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes
      -o ServerAliveInterval=15 -o ServerAliveCountMax=4
      -o UserKnownHostsFile="$KNOWN_HOSTS")
SSH=(ssh "${OPTS[@]}" "root@$IP")   # slurm_login_ssh_root_public_keys are root keys

for _ in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 5; done
"${SSH[@]}" true 2>&1 | tee -a "$OUT" || fail "login node $IP not reachable over SSH"

# What soperator/test/deliver.sh -t quickcheck does, with our SSH options (it cannot take a known_hosts file).
"${SSH[@]}" "mkdir -p $REMOTE_DIR/results" 2>&1 | tee -a "$OUT"
scp "${OPTS[@]}" -q -r "$QUICKCHECK"/. "root@$IP:$REMOTE_DIR/" 2>&1 | tee -a "$OUT"

# hello.sh asks for 4 GPUs and 16G; the CPU worker is 8vcpu-32gb with no GPU, so override both.
# Its nvidia-smi step fails on a CPU node; the job still finishes (no `set -e` in hello.sh).
"${SSH[@]}" bash -s -- "$REMOTE_DIR" <<'REMOTE' 2>&1 | tee -a "$OUT"
set -euo pipefail
cd "$1"
rm -f results/hello.out
echo "== sinfo =="
timeout 60 sinfo
id=$(timeout 60 sbatch --parsable --gpus-per-node=0 --mem=4G hello.sh)
echo "== sbatch hello.sh: job $id =="
deadline=$((SECONDS + 900))   # first job on a fresh cluster can wait for the worker pod
# Poll until the job leaves the queue; a squeue error is a failure, not an empty queue.
while :; do
  if ! queue=$(timeout 30 squeue -h -j "$id" 2>&1); then
    echo "squeue failed for job $id: $queue"; exit 1
  fi
  [[ -z "$queue" ]] && break
  if (( SECONDS >= deadline )); then
    echo "job $id still queued/running after 15 min:"; timeout 30 squeue -j "$id" || true
    timeout 30 scancel "$id" || true
    exit 1
  fi
  sleep 10
done
# The health gate is the terminal state, not the presence of an output file.
state=$(timeout 60 scontrol show job "$id" | grep -oE 'JobState=[A-Z_]+' | head -1)
echo "== $state =="
[[ "$state" == "JobState=COMPLETED" ]] || { echo "job $id did not complete: $state"; exit 1; }
echo "== results/hello.out =="
cat results/hello.out
echo "== scontrol show nodes | head -40 =="
timeout 60 scontrol show nodes | head -40
REMOTE

