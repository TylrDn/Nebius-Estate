#!/usr/bin/env bash
# scripts/live/run2-all.sh: the one-command run-2 batch, against stub step scripts (no cloud).
# On 2026-10-12 a failed GPU-layer check in step 3a left vLLM undeployed and the batch carried on
# without saying so; a one-off recovery block in run2-9 re-ran 3a-3d by hand. The documented
# behaviour now: 00/01 failing skips the vLLM steps BY NAME (3c runs 03-storage only), a failed 02
# is reported but vLLM is deployed, an apply failure goes straight to teardown, a teardown failure
# says abort.sh, and the exit code tells PASS (0) / PARTIAL (3) / FAIL (1).
# The batch needs a terminal (its steps prompt); the test gives it a pseudo-terminal.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset ASSUME_YES R12_BATCH_MLFLOW_PW R12_BATCH_PG_PW NIP_RUN SSH_CONNECTION

R="${work}/repo"; L="${R}/scripts/live"; ST="${R}/.cache/live/state"
mkdir -p "${L}" "${ST}"
cp "${repo_root}/scripts/live/lib.sh" "${repo_root}/scripts/live/run2-all.sh" "${L}/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/"
: > "${R}/Makefile"
STEPS="run2-0-preflight run2-1-reprice run2-2a-data run2-2b-ml-services run2-2c-inference run2-2d-rearm
run2-3a-validate-gpu run2-3b-headroom run2-3c-storage-workload run2-3d-load run2-4-r8-acceptance
run2-5-r12-acceptance run2-6-r14-acceptance run2-7-r5 run2-9-evidence run2-10-teardown run2-11-leftovers"
# Each stub step logs its name and inputs, then exits with $work/rc/<name> (default 0). The 3a stub
# writes the layer results from $work/gpu (three statuses) like the real step does.
for s in ${STEPS}; do
  cat > "${L}/${s}.sh" <<EOF
#!/usr/bin/env bash
echo "${s} yes=\${ASSUME_YES:-} nowl=\${NO_WORKLOAD:-} run=\${NIP_RUN:-} pw=\$([[ "\${R12_BATCH_MLFLOW_PW:-}" == 'Mlflow-pw1' && "\${R12_BATCH_PG_PW:-}" == 'Pg-pass#1' ]] && echo ok || echo bad) tty=\$([[ -t 0 ]] && echo y || echo n)" >> "${work}/steps.log"
if [[ "${s}" == run2-3a-validate-gpu ]]; then
  read -r l0 l1 l2 < "${work}/gpu"
  { echo "GPU_L00=\${l0}"; echo "GPU_L01=\${l1}"; echo "GPU_L02=\${l2}"
    if [[ "\${l0}\${l1}" == passpass ]]; then echo VLLM_DEPLOYED=1; else echo VLLM_DEPLOYED=0; fi; } >> "${ST}/run2.env"
fi
exit "\$(cat "${work}/rc/${s}" 2>/dev/null || echo 0)"
EOF
done
printf "R12_MLFLOW_ADMIN_PASSWORD='Mlflow-pw1'\nR12_POSTGRESQL_PASSWORD='Pg-pass#1'\n" > "${R}/.env"; chmod 600 "${R}/.env"

# batch [env...]: run2-all.sh on a pseudo-terminal from a fresh state; its output in $out, its exit
# code in $brc. Step exit codes come from $work/rc/<step> (set before, removed after).
batch() {
  rm -rf "${ST}" "${R}/.cache/live/logs"; mkdir -p "${ST}" "${work}/rc"; : > "${work}/steps.log"
  [[ -f "${work}/gpu" ]] || echo "pass pass pass" > "${work}/gpu"
  set +e
  out="$(env ASSUME_YES=1 LIVE_ALLOW_TMP=1 "$@" python3 -c 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' \
    bash "${L}/run2-all.sh" </dev/null 2>&1)"
  brc=$?
  set -e
  rm -rf "${work}/rc" "${work}/gpu"
}
ran() { awk '{print $1}' "${work}/steps.log" | tr '\n' ' '; }
summary_file() { local f; for f in "${R}"/.cache/live/logs/run2-all-*.summary; do :; done; printf '%s' "${f}"; }

test_name=live-batch-all-pass
batch
[[ "${brc}" == 0 ]] || fail "every step passing exits 0 (got ${brc}): ${out}"
[[ "$(ran)" == "run2-0-preflight run2-1-reprice run2-2a-data run2-2b-ml-services run2-2c-inference run2-2d-rearm run2-3a-validate-gpu run2-3b-headroom run2-3c-storage-workload run2-3d-load run2-4-r8-acceptance run2-5-r12-acceptance run2-6-r14-acceptance run2-7-r5 run2-9-evidence run2-10-teardown run2-11-leftovers run2-9-evidence " ]] \
  || fail "plan order, evidence before and after the teardown: $(ran)"
grep -q 'VERDICT: PASS' <<<"${out}" || fail "the batch ends with a VERDICT: ${out}"
grep -qv 'pw=ok' "${work}/steps.log" && fail "every step gets the R12 passwords from .env: $(cat "${work}/steps.log")"
grep -qv 'yes=1' "${work}/steps.log" && fail "every step runs with ASSUME_YES=1"
grep -qv 'tty=y' "${work}/steps.log" && fail "steps keep the terminal (2b, 4-7 need one)"
grep -q "run=live-$(date -u +%Y%m%d)-run2" "${work}/steps.log" || fail "a default run ticket is passed"
grep -q 'Mlflow-pw1\|Pg-pass#1' <<<"${out}" && fail "a password was printed"
grep -q 'GPU layers: 00-nodes pass / 01-gpu pass / 02-interconnect pass; vLLM deployed: yes' "$(summary_file)" || fail "the summary reports the GPU layers: $(cat "$(summary_file)")"
ok "plan order, passwords from .env to every step (never printed), VERDICT PASS, exit 0"

test_name=live-batch-gpu-layer-fails
echo "pass fail missing" > "${work}/gpu"; batch
[[ "${brc}" == 3 ]] || fail "a skipped step with a clean teardown is PARTIAL, exit 3 (got ${brc}): ${out}"
s="$(cat "$(summary_file)")"
grep -q 'vLLM deployed: NO' <<<"${s}" || fail "the summary says vLLM was not deployed: ${s}"
grep -q 'run2-3b-headroom  *SKIPPED: step 3a did not deploy vLLM (00-nodes pass, 01-gpu fail' <<<"${s}" || fail "3b is skipped by name with the reason: ${s}"
grep -q 'run2-3d-load  *SKIPPED' <<<"${s}" || fail "3d is skipped by name: ${s}"
grep -q '^run2-3c-storage-workload .*nowl=1' "${work}/steps.log" || fail "3c runs 03-storage only (NO_WORKLOAD=1): $(cat "${work}/steps.log")"
[[ "$(ran)" == *"run2-4-r8-acceptance run2-5-r12-acceptance run2-6-r14-acceptance run2-7-r5 run2-9-evidence run2-10-teardown run2-11-leftovers"* ]] \
  || fail "the checks that do not need vLLM still run, then the teardown: $(ran)"
grep -q 'VERDICT: PARTIAL' <<<"${out}" || fail "PARTIAL verdict: ${out}"
ok "00/01 failing: vLLM steps skipped by name, 03-storage still measured, teardown runs, exit 3"

test_name=live-batch-interconnect-fails
echo "pass pass fail" > "${work}/gpu"; batch
[[ "${brc}" == 3 ]] || fail "a failed 02 is PARTIAL, exit 3 (got ${brc})"
s="$(cat "$(summary_file)")"
grep -q '02-interconnect did not pass (recorded); vLLM was deployed anyway' <<<"${s}" || fail "a failed 02 is reported: ${s}"
[[ "$(ran)" == *"run2-3b-headroom run2-3c-storage-workload run2-3d-load"* ]] || fail "vLLM is up, so 3b-3d run: $(ran)"
grep -q '^run2-3c-storage-workload .*nowl= ' "${work}/steps.log" || fail "3c runs both 03 and 04"
ok "02 failing: reported, vLLM steps still run"

test_name=live-batch-apply-fails
mkdir -p "${work}/rc"; echo 1 > "${work}/rc/run2-2b-ml-services"; batch
[[ "${brc}" == 3 ]] || fail "an apply failure with a clean teardown is PARTIAL, exit 3 (got ${brc}): ${out}"
[[ "$(ran)" == "run2-0-preflight run2-1-reprice run2-2a-data run2-2b-ml-services run2-9-evidence run2-10-teardown run2-11-leftovers run2-9-evidence " ]] \
  || fail "no apply or check after a failed apply; straight to teardown: $(ran)"
grep -q 'an apply step failed: no further applies; going to teardown' "$(summary_file)" || fail "the summary says why"
ok "an apply failure stops the applies and goes to teardown"

test_name=live-batch-teardown-fails
mkdir -p "${work}/rc"; echo 2 > "${work}/rc/run2-10-teardown"; batch
[[ "${brc}" == 1 ]] || fail "a failed teardown exits 1 (got ${brc}): ${out}"
grep -q 'TEARDOWN FAILED: resources may still bill. Run now:  bash .*/scripts/live/abort.sh' <<<"${out}" || fail "it names abort.sh: ${out}"
[[ "$(ran)" != *run2-11-leftovers* ]] || fail "no leftovers gate after a failed teardown: $(ran)"
ok "a failed teardown stops the batch, exit 1, and names abort.sh"

test_name=live-batch-refusals
printf "R12_MLFLOW_ADMIN_PASSWORD=\nR12_POSTGRESQL_PASSWORD=\n" > "${R}/.env"
batch
[[ "${brc}" == 1 && ! -s "${work}/steps.log" ]] || fail "ASSUME_YES=1 without the passwords in .env starts nothing (rc ${brc}): $(ran) ${out}"
grep -q 'needs R12_MLFLOW_ADMIN_PASSWORD and R12_POSTGRESQL_PASSWORD in .env' <<<"${out}" || fail "the refusal says why: ${out}"
printf "R12_MLFLOW_ADMIN_PASSWORD=short\nR12_POSTGRESQL_PASSWORD='Pg-pass#1'\n" > "${R}/.env"
batch
[[ "${brc}" == 1 && ! -s "${work}/steps.log" ]] || fail "a password that breaks the stack's rules starts nothing: ${out}"
grep -q 'MLflow password: 8-64 chars' <<<"${out}" || fail "the rule is named: ${out}"
out="$(env ASSUME_YES=1 LIVE_ALLOW_TMP=1 bash "${L}/run2-all.sh" </dev/null 2>&1)" && fail "without a terminal the batch refuses"
grep -q 'real terminal' <<<"${out}" || fail "the refusal says why: ${out}"
ok "missing or invalid passwords and a missing terminal start nothing"
