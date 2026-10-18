#!/usr/bin/env bash
# docs/rescoping.md covers every recipe R1-R16 with the four client dimensions (workload, scale,
# region, budget), what the change costs and what proves it; and every R1 input it names exists in
# the script that reads it, so the guide cannot drift from render.sh, lib-bench.sh, bench.sh or 03-nccl.sh.
# (Links and anchors are checked by `make md-links`.)
# shellcheck disable=SC2016  # the backticks in single-quoted patterns are literal Markdown code spans
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
doc="${repo_root}/docs/rescoping.md"
test_name=rescoping-doc
[[ -f "${doc}" ]] || fail "docs/rescoping.md is missing"
for n in $(seq 1 16); do
  section="$(awk -v h="^## R${n} " '$0 ~ h {p=1; print; next} /^## /{p=0} p' "${doc}")"
  [[ -n "${section}" ]] || fail "no '## R${n} ' section"
  for row in Workload Scale Region Budget Costs 'Proved by'; do
    grep -q "^| ${row} |" <<<"${section}" || fail "R${n}: no '| ${row} |' row"
  done
done
ok "R1-R16 each have workload, scale, region, budget, cost and proof rows"

test_name=rescoping-doc-inputs
for v in $(grep -oE '`(BENCH_[A-Z_]+)' "${doc}" | tr -d '`' | sort -u); do
  # The sweep shape is lib-bench.sh's; R11's model and tokenizer inputs are bench.sh's own.
  grep -q "\${${v}" "${repo_root}/tests/load/lib-bench.sh" "${repo_root}/tests/load/bench.sh" \
    || fail "${v} named in the guide is not read by tests/load/lib-bench.sh or tests/load/bench.sh"
done
for v in MODEL MODEL_REVISION MAX_MODEL_LEN GPU_MEMORY_UTILIZATION OVERLAY; do
  grep -q "\`${v}\`" "${doc}" || fail "R1 input ${v} is not in the guide"
  grep -q "${v}" "${repo_root}/workloads/inference/render.sh" || fail "${v} is not read by render.sh"
done
grep -q '`NCCL_MIN_BUSBW`' "${doc}" || fail "the NCCL bar input is not in the guide"
ok "every R1 input in the guide exists in its script"

# Every bar (`*_MIN_*`) the guide names in a table cell after a script is read by the nearest
# script named before it in that cell, so a renamed bar (data.sh's DATA_MIN_MIBPS -> COPY_MIN_MIBPS)
# cannot leave the guide setting a variable the script ignores: a false pass. A cell that names a
# bar with no script before it (the Default column) is not checked.
test_name=rescoping-doc-bars
checked=0
while IFS= read -r cell; do
  script=""
  while IFS= read -r tok; do
    [[ -n "${tok}" ]] || continue
    case "${tok}" in
      *.sh|*.py) script="${tok##*/}" ;;
      *) [[ -n "${script}" ]] || continue
         path="$(find "${repo_root}/tests" "${repo_root}/recipes" -name "${script}" -not -path '*/fixtures/*' | head -1)"
         [[ -n "${path}" ]] || fail "${script} named in the guide does not exist"
         grep -qE "\\\$\\{?${tok}([^A-Z0-9_]|$)" "${path}" || fail "${tok} is named for ${script}, which does not read it"
         checked=$((checked + 1)) ;;
    esac
  done < <(grep -oE '[A-Za-z0-9_./-]+\.(sh|py)|\b[A-Z][A-Z0-9]*_MIN_[A-Z0-9_]+' <<<"${cell}" || true)
done < <(grep -E '\b[A-Z][A-Z0-9]*_MIN_[A-Z0-9_]+' "${doc}" | awk '{gsub(/ [|] /, "\n"); print}')
(( checked >= 3 )) || fail "only ${checked} bars checked; expected DATA_MIN_MIBPS, COPY_MIN_MIBPS and NCCL_MIN_BUSBW at least"
ok "every bar in the guide is read by the script it names"

# Every acceptance script that declares its recipe (`# R<n> ...` on line 2) is named in that
# recipe's section, so a new proof cannot be missing from the client guide.
test_name=rescoping-doc-proofs
for f in "${repo_root}"/tests/validate/*.sh "${repo_root}"/recipes/*/acceptance.sh; do
  n="$(sed -n '2s/^# R\([0-9][0-9]*\)[^0-9].*/\1/p' "${f}")"
  [[ -n "${n}" ]] || continue
  section="$(awk -v h="^## R${n} " '$0 ~ h {p=1; next} /^## /{p=0} p' "${doc}")"
  grep -q "$(basename "${f}")" <<<"${section}" || fail "R${n}: $(basename "${f}") is not named in its section"
done
ok "every acceptance script is named in its recipe's section"
