#!/usr/bin/env bash
# recipes/serverless/compare.py reads the tests/load result shape (nip-bench/1) on both sides and
# labels the comparison: like-for-like only when the generator ran in-region on both sides with
# the same image, model and sweep; otherwise "not like-for-like" with the reasons. A side that
# did not pass prints "not measured", never a number.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cmp="${repo_root}/recipes/serverless/compare.py"
bench="${repo_root}/tests/load/bench.py"
fx="${repo_root}/tests/load/fixtures/sweep-pass.log"
res="${work}/results"; out="${work}/cmp.md"; mkdir -p "${res}"
export PYTHONDONTWRITEBYTECODE=1
unset BAR_MAX_TTFT_P99_MS BAR_MAX_TPOT_P99_MS BAR_MAX_E2E_P99_MS BAR_MIN_OUTPUT_TPS BAR_MIN_SUCCESS_RATIO \
  BENCH_USD_PER_HOUR BENCH_UTILISATION BENCH_USD_PER_1M_OUTPUT
img="vllm/vllm-openai:v0@sha256:00"
wrap() { # <step> <json details> -> a passing result file
  jq -n --arg s "$1" --argjson d "$2" '{step:$s,status:"pass",details:$d}' > "${res}/$1.json"
}
lab() { # [image] [region]
  wrap 05-load "$(python3 "${bench}" parse "${fx}" --target r1 --vantage in-cluster --image "${1:-$img}" | jq --arg r "${2-eu-north1}" '. + {region:(if $r=="" then null else $r end)}')"
}
ep() { # <vantage> [image] [endpoint region] [generator region]
  wrap serverless-endpoint-measure "$(python3 "${bench}" parse "${fx}" --target r6 --vantage "$1" --image "${2:-$img}" \
    | jq --arg er "${3-eu-north1}" --arg gr "${4-eu-north1}" \
      '. + {first_request_ms:120,response:"OK",endpoint_region:(if $er=="" then null else $er end),generator_region:(if $gr=="" then null else $gr end)}')"
}
wrap 04-workload '{"image":"'"${img}"'","model":"Qwen/Qwen2.5-1.5B-Instruct","startup_seconds":312,"first_request_ms":90}'
wrap serverless-endpoint-create '{"image":"'"${img}"'","model":"Qwen/Qwen2.5-1.5B-Instruct","preset":"gpu-l40s-a/1gpu-8vcpu-32gb","cold_start_seconds":400}'
run() { python3 "${cmp}" --results "${res}" --out "${out}" >/dev/null || fail "compare.py failed"; }

test_name=compare-in-region-is-like-for-like
lab; ep in-region-cluster-job; run
grep -q '^| Region | eu-north1 | eu-north1 (generator eu-north1) |' "${out}" || fail "the region row is missing: $(grep -i region "${out}")"
grep -q '^| Like-for-like | yes' "${out}" || fail "in-region on both sides must be like-for-like: $(grep -i like "${out}")"
grep -q '^| Generator vantage | in-cluster | in-region-cluster-job |' "${out}" || fail "the vantage row is missing: $(cat "${out}")"
grep -q '^| Output tokens/s @ 32 | 3904.0 | 3904.0 |' "${out}" || fail "per-point rows must come from the sweep: $(grep 'tokens/s' "${out}")"
grep -q '^| E2E p50 / p99 (ms) @ 8 | 690.7 / 900.2 | 690.7 / 900.2 |' "${out}" || fail "per-point latency rows missing: $(grep E2E "${out}")"
ok "in-region endpoint vs in-cluster lab: like-for-like"

test_name=compare-operator-host-is-not
ep operator-host; run
grep -q '^| Like-for-like | no: .*operator host' "${out}" || fail "an operator-host run must be labelled not like-for-like: $(grep -i like "${out}")"
ok "operator-host endpoint run: not like-for-like, with the reason"

test_name=compare-image-mismatch-is-not
ep in-region-cluster-job "vllm/vllm-openai:v1@sha256:11"; run
grep -q '^| Like-for-like | no: .*image' "${out}" || fail "a different image must be named: $(grep -i like "${out}")"
ok "image mismatch named"

test_name=compare-region-differs-is-not
lab; ep in-region-cluster-job "${img}" eu-west2 eu-north1; run
grep -q '^| Like-for-like | no: .*endpoint in eu-west2.*eu-north1' "${out}" || fail "an endpoint in another region must be named: $(grep -i like "${out}")"
ok "endpoint in another region: not like-for-like"

test_name=compare-generator-other-cluster-is-not
lab; ep in-region-cluster-job "${img}" eu-north1 us-central1; run
grep -q '^| Like-for-like | no: .*generator ran in us-central1' "${out}" || fail "a Job in another cluster's region must be named: $(grep -i like "${out}")"
ok "endpoint generator in another region: not like-for-like"

test_name=compare-region-unrecorded-is-not
lab "${img}" ""; ep in-region-cluster-job "${img}" "" ""; run
grep -q '^| Like-for-like | no: .*region not recorded' "${out}" || fail "an unrecorded region cannot be called in-region: $(grep -i like "${out}")"
ok "unrecorded region: not like-for-like"

test_name=compare-warmup-differs-is-not
lab; ep in-region-cluster-job
jq '.details.params.warmup_prompts = "0"' "${res}/serverless-endpoint-measure.json" > "${work}/m.json" && mv "${work}/m.json" "${res}/serverless-endpoint-measure.json"
run
grep -q '^| Like-for-like | no: .*warmup_prompts' "${out}" || fail "a different warm-up must be named: $(grep -i like "${out}")"
ok "warm-up mismatch named"

test_name=compare-unshared-point-not-measured
lab; ep in-region-cluster-job
jq '.details.points |= map(select(.concurrency != 32)) | .details.params.concurrency = "1,8"' "${res}/serverless-endpoint-measure.json" > "${work}/m.json" && mv "${work}/m.json" "${res}/serverless-endpoint-measure.json"
run
grep -q '^| Like-for-like | yes' "${out}" || fail "a shorter concurrency list still compares the shared points: $(grep -i like "${out}")"
grep -q '^| Output tokens/s @ 32 | 3904.0 | not measured |' "${out}" || fail "a point only one side ran must print not measured: $(grep 'tokens/s' "${out}")"
ok "a point only one side ran prints not measured"

test_name=compare-note-names-the-paths
{ grep -q 'Service over plain HTTP' "${out}" && grep -q 'managed https:// URL' "${out}"; } || fail "the note must name the two network paths: $(tail -8 "${out}")"
ok "note names Service vs managed URL"

test_name=compare-missing-side-not-measured
rm -f "${res}/serverless-endpoint-measure.json"; run
grep -q '^| Like-for-like | not measured' "${out}" || fail "a missing side must not be compared: $(grep -i like "${out}")"
grep -q '^| Output tokens/s @ 32 | 3904.0 | not measured |' "${out}" || fail "the missing side must print not measured: $(grep 'tokens/s' "${out}")"
ok "missing side prints not measured"
