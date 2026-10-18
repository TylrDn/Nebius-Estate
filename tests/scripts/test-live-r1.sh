#!/usr/bin/env bash
# scripts/live/run-r1.sh: the one-command R1-only session (no R8 filesystem, no R12 node identity),
# against stub step scripts (no cloud). R1 is applied alone on l40s-gpu-only with its own filestore;
# the batch then validates 00-02, deploys vLLM, runs 03/04/05-load, R14 and R5, tears R1 down, and
# with R10_TOO=1 runs the R10 GPU VM bench (run 3) after R1 is gone, before the stage leftovers gate.
# Every step gets R1_ONLY=1 and ASSUME_YES=1; an apply failure goes to teardown; a failed teardown
# stops everything and names abort.sh; the exit code tells PASS (0) / PARTIAL (3) / FAIL (1).
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset ASSUME_YES R1_ONLY R10_TOO R5 NIP_RUN SSH_CONNECTION

R="${work}/repo"; L="${R}/scripts/live"; ST="${R}/.cache/live/state"
mkdir -p "${L}" "${ST}"
cp "${repo_root}/scripts/live/lib.sh" "${repo_root}/scripts/live/run-r1.sh" "${L}/"
cp "${repo_root}/scripts/lib-time.sh" "${R}/scripts/"
: > "${R}/Makefile"
STEPS="run2-0-preflight run2-1-reprice run2-2c-inference run2-2d-rearm run2-3a-validate-gpu run2-3b-headroom
run2-3c-storage-workload run2-3d-load run2-4-r8-acceptance run2-5-r12-acceptance run2-6-r14-acceptance run2-7-r5
run2-9-evidence run2-10-teardown run2-11-leftovers run3-2-plan run3-3-apply run3-4-bench run3-5-teardown"
# Each stub step logs its name and inputs, then exits with $work/rc/<name> (default 0). The 3a stub
# writes the layer results from $work/gpu like the real step; the R14 stub records cause classes.
for s in ${STEPS}; do
  cat > "${L}/${s}.sh" <<EOF
#!/usr/bin/env bash
echo "${s} yes=\${ASSUME_YES:-} r1=\${R1_ONLY:-} nowl=\${NO_WORKLOAD:-} run=\${NIP_RUN:-} tty=\$([[ -t 0 ]] && echo y || echo n)" >> "${work}/steps.log"
if [[ "${s}" == run2-3a-validate-gpu ]]; then
  read -r l0 l1 l2 < "${work}/gpu"
  { echo "GPU_L00=\${l0}"; echo "GPU_L01=\${l1}"; echo "GPU_L02=\${l2}"
    if [[ "\${l0}\${l1}" == passpass ]]; then echo VLLM_DEPLOYED=1; else echo VLLM_DEPLOYED=0; fi; } >> "${ST}/run2.env"
fi
if [[ "${s}" == run2-6-r14-acceptance && -f "${work}/r14" ]]; then cat "${work}/r14" >> "${ST}/run2.env"; fi
exit "\$(cat "${work}/rc/${s}" 2>/dev/null || echo 0)"
EOF
done
: > "${R}/.env"; chmod 600 "${R}/.env"

# batch [env...]: run-r1.sh on a pseudo-terminal from a fresh state; output in $out, exit code in $brc.
batch() {
  rm -rf "${ST}" "${R}/.cache/live/logs"; mkdir -p "${ST}" "${work}/rc"; : > "${work}/steps.log"
  [[ -f "${work}/gpu" ]] || echo "pass pass pass" > "${work}/gpu"
  set +e
  out="$(env ASSUME_YES=1 LIVE_ALLOW_TMP=1 "$@" python3 -c 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' \
    bash "${L}/run-r1.sh" </dev/null 2>&1)"
  brc=$?
  set -e
  rm -rf "${work}/rc" "${work}/gpu" "${work}/r14"
}
ran() { awk '{print $1}' "${work}/steps.log" | tr '\n' ' '; }
summary_file() { local f; for f in "${R}"/.cache/live/logs/run-r1-*.summary; do :; done; printf '%s' "${f}"; }
CORE="run2-0-preflight run2-1-reprice run2-2c-inference run2-3a-validate-gpu run2-3b-headroom run2-3c-storage-workload run2-3d-load run2-6-r14-acceptance"

test_name=live-r1-all-pass
batch
[[ "${brc}" == 0 ]] || fail "every step passing exits 0 (got ${brc}): ${out}"
[[ "$(ran)" == "${CORE} run2-7-r5 run2-9-evidence run2-10-teardown run2-11-leftovers run2-9-evidence " ]] \
  || fail "R1 alone, in plan order; no R8/R12 step, no 2d re-arm; evidence before and after the teardown: $(ran)"
grep -qv 'r1=1' "${work}/steps.log" && fail "every step runs with R1_ONLY=1: $(cat "${work}/steps.log")"
grep -qv 'yes=1' "${work}/steps.log" && fail "every step runs with ASSUME_YES=1"
grep -qv 'tty=y' "${work}/steps.log" && fail "steps keep the terminal (R14 and R5 need one)"
grep -q "run=live-$(date -u +%Y%m%d)-r1" "${work}/steps.log" || fail "a default R1 run ticket is passed: $(cat "${work}/steps.log")"
grep -q 'VERDICT: PASS' <<<"${out}" || fail "the batch ends with a VERDICT: ${out}"
grep -q 'GPU layers: 00-nodes pass / 01-gpu pass / 02-interconnect pass; vLLM deployed: yes' "$(summary_file)" || fail "the summary reports the GPU layers: $(cat "$(summary_file)")"
ok "R1 alone: preflight, re-price, apply, 00-05, R14, R5, teardown, leftovers gate; exit 0"

test_name=live-r1-without-r5
batch R5=0
[[ "${brc}" == 0 ]] || fail "R5=0 is not a failure (got ${brc}): ${out}"
[[ "$(ran)" != *run2-7-r5* ]] || fail "R5=0 skips R5: $(ran)"
grep -q 'run2-7-r5  *NOT RUN: R5=0' "$(summary_file)" || fail "the summary says R5 was left out on purpose: $(cat "$(summary_file)")"
ok "R5=0 leaves R5 out, by name, without failing the session"

test_name=live-r1-r14-cause
echo 'R14_CAUSES=datasource_token_rejected' > "${work}/r14"; echo 'R14_TOKEN=absent' >> "${work}/r14"
mkdir -p "${work}/rc"; echo 1 > "${work}/rc/run2-6-r14-acceptance"
batch
[[ "${brc}" == 3 ]] || fail "a failed R14 with a clean teardown is PARTIAL, exit 3 (got ${brc}): ${out}"
grep -q 'R14: token Secret absent; cause classes: datasource_token_rejected' "$(summary_file)" || fail "the R14 cause class is in the summary: $(cat "$(summary_file)")"
[[ "$(ran)" == *"run2-6-r14-acceptance run2-7-r5 run2-9-evidence run2-10-teardown"* ]] || fail "the batch carries on after a failed check: $(ran)"
ok "R14 failing: its cause class and token state are reported, the batch carries on"

test_name=live-r1-gpu-layer-fails
echo "pass fail missing" > "${work}/gpu"; batch
[[ "${brc}" == 3 ]] || fail "skipped steps with a clean teardown are PARTIAL, exit 3 (got ${brc})"
s="$(cat "$(summary_file)")"
grep -q 'run2-3b-headroom  *SKIPPED: step 3a did not deploy vLLM' <<<"${s}" || fail "3b skipped by name: ${s}"
grep -q 'run2-3d-load  *SKIPPED' <<<"${s}" || fail "3d skipped by name: ${s}"
grep -q '^run2-3c-storage-workload .*nowl=1' "${work}/steps.log" || fail "3c runs 03-storage only: $(cat "${work}/steps.log")"
[[ "$(ran)" == *"run2-6-r14-acceptance run2-7-r5 run2-9-evidence run2-10-teardown run2-11-leftovers"* ]] || fail "R14 and R5 do not need vLLM: $(ran)"
ok "00/01 failing: vLLM steps skipped by name, 03 on R1's own filestore, R14/R5 still run"

test_name=live-r1-apply-fails
mkdir -p "${work}/rc"; echo 1 > "${work}/rc/run2-2c-inference"; batch R10_TOO=1
[[ "${brc}" == 3 ]] || fail "an apply failure with a clean teardown is PARTIAL (got ${brc}): ${out}"
[[ "$(ran)" == "run2-0-preflight run2-1-reprice run2-2c-inference run2-9-evidence run2-10-teardown run3-2-plan run3-3-apply run3-4-bench run3-5-teardown run2-11-leftovers run2-9-evidence " ]] \
  || fail "no check after a failed R1 apply; teardown; R10 still runs once R1 is torn down: $(ran)"
ok "an R1 apply failure goes to teardown; R10_TOO still runs after it"

test_name=live-r1-with-r10
batch R10_TOO=1
[[ "${brc}" == 0 ]] || fail "R1 and R10 passing exits 0 (got ${brc}): ${out}"
[[ "$(ran)" == "${CORE} run2-7-r5 run2-9-evidence run2-10-teardown run3-2-plan run3-3-apply run3-4-bench run3-5-teardown run2-11-leftovers run2-9-evidence " ]] \
  || fail "R10 runs after R1's teardown and before the stage gate: $(ran)"
ok "R10_TOO=1: run 3 after R1 is torn down, then the leftovers gate"

test_name=live-r1-r10-apply-fails
mkdir -p "${work}/rc"; echo 1 > "${work}/rc/run3-3-apply"; batch R10_TOO=1
[[ "${brc}" == 3 ]] || fail "an R10 apply failure with a clean teardown is PARTIAL (got ${brc})"
[[ "$(ran)" == *"run3-2-plan run3-3-apply run3-5-teardown run2-11-leftovers"* ]] || fail "no bench after a failed R10 apply; its teardown runs: $(ran)"
ok "an R10 apply failure skips the bench and tears R10 down"

test_name=live-r1-teardown-fails
mkdir -p "${work}/rc"; echo 2 > "${work}/rc/run2-10-teardown"; batch R10_TOO=1
[[ "${brc}" == 1 ]] || fail "a failed R1 teardown exits 1 (got ${brc})"
grep -q 'TEARDOWN FAILED: resources may still bill. Run now:  bash .*/scripts/live/abort.sh' <<<"${out}" || fail "it names abort.sh: ${out}"
[[ "$(ran)" != *run3-* && "$(ran)" != *run2-11-leftovers* ]] || fail "nothing new starts after a failed teardown: $(ran)"
ok "a failed R1 teardown stops the batch (R10 never starts), exit 1, names abort.sh"

test_name=live-r1-r10-teardown-fails
mkdir -p "${work}/rc"; echo 2 > "${work}/rc/run3-5-teardown"; batch R10_TOO=1
[[ "${brc}" == 1 ]] || fail "a failed R10 teardown exits 1 (got ${brc})"
grep -q 'TEARDOWN FAILED' <<<"${out}" || fail "it says so: ${out}"
[[ "$(ran)" != *run2-11-leftovers* ]] || fail "no gate after a failed teardown: $(ran)"
ok "a failed R10 teardown stops the batch, exit 1"

test_name=live-r1-refusals
out="$(env ASSUME_YES=1 LIVE_ALLOW_TMP=1 bash "${L}/run-r1.sh" </dev/null 2>&1)" && fail "without a terminal the batch refuses"
grep -q 'real terminal' <<<"${out}" || fail "the refusal says why: ${out}"
batch R10_TOO=maybe
[[ "${brc}" == 1 && ! -s "${work}/steps.log" ]] || fail "a toggle that is not 0 or 1 starts nothing: ${out}"
ok "no terminal, or a malformed toggle: nothing starts"
