#!/usr/bin/env bash
# Fixture self-test for the NCCL log parser (runs in CI, needs only bash + jq):
# an InfiniBand 2x8 run parses as ib with its busbw; the real single-B300 log parses as
# roce (NET/IB prefix, /RoCE suffix); a socket fallback parses as socket. Then the per-platform
# NCCL bar table, the DDP samples/s parser and train.py's summary, and the load harness.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=tests/validate/lib-nccl.sh
source ./lib-nccl.sh
check() { # <fixture> <jq-condition>
  local out; out="$(nccl_parse "fixtures/$1")"
  jq -e "$2" <<<"$out" >/dev/null || { echo "FAIL $1: $2"; echo "$out"; exit 1; }
  echo "ok   $1"
}
check nccl-ib-2x8.log          '.transport=="ib" and .out_of_bounds_ok and .avg_bus_bandwidth_GBps>=300 and (.table|length)==3 and .nccl_version=="NCCL version 2.23.4+cuda12.4"'
check nccl-roce-1gpu.log       '.transport=="roce" and .out_of_bounds_ok and .avg_bus_bandwidth_GBps==0'
check nccl-socket-fallback.log '.transport=="socket" and .avg_bus_bandwidth_GBps<300'
echo "nccl parser self-test passed"

# Per-platform NCCL bars (nccl-bars.tsv): the docs' bar is platform-general; a platform-specific
# figure is only what the docs show, and unknown where they show none.
bar() { # <platform> <jq-condition>
  local out; out="$(nccl_bar "$1")"
  jq -e "$2" <<<"$out" >/dev/null || { echo "FAIL nccl_bar $1: $2"; echo "$out"; exit 1; }
  echo "ok   nccl_bar $1"
}
bar gpu-h100-sxm  '.min_busbw_GBps==300 and .docs_example_avg_busbw_GBps==317.11 and (.source|test("kubernetes/gpu/nccl-test"))'
bar gpu-h200-sxm  '.min_busbw_GBps==300 and .docs_example_avg_busbw_GBps==355.703 and (.example_source|test("nccl-all-reduce"))'
bar gpu-b300-sxm  '.min_busbw_GBps==300 and .docs_example_avg_busbw_GBps==null and .example_source=="unknown: the docs show no B300 figure"'
bar gpu-b200-sxm  '.min_busbw_GBps==300 and .docs_example_avg_busbw_GBps==null'
bar gpu-l40s-a    '.min_busbw_GBps==null and (.source|test("not listed"))'

# DDP: the rank-0 summary line becomes samples/s in JSON; a run without it is not a result.
# shellcheck source=tests/validate/lib-ddp.sh
source ./lib-ddp.sh
ddp() { # <fixture> <jq-condition>
  local out; out="$(ddp_parse "fixtures/$1")"
  jq -e "$2" <<<"$out" >/dev/null || { echo "FAIL $1: $2"; echo "$out"; exit 1; }
  echo "ok   $1"
}
ddp ddp-2x8.log        '.found and .samples_per_s==81920 and .world_size==16 and .batch_per_rank==64 and .step_ms_p50==12.5 and .nccl=="2.27.5" and .transport=="ib"'
ddp ddp-no-summary.log '(.found|not) and .samples_per_s==null'
# train.py computes samples/s from the step times (torch stubbed: the summary is plain Python).
python3 -I - "${PWD}/../../workloads/training/ddp/train.py" <<'PY' || { echo "FAIL train.py summary"; exit 1; }
import importlib.util, sys, types
for name in ("torch", "torch.distributed", "torch.nn"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["torch"].distributed = sys.modules["torch.distributed"]; sys.modules["torch"].nn = sys.modules["torch.nn"]
spec = importlib.util.spec_from_file_location("train", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.summary([1.0] * 5 + [0.0125] * 15, world=16, batch=64)
assert s["samples_per_s"] == 81920.0 and s["step_ms_p50"] == 12.5 and s["batch_per_rank"] == 64, s
PY
echo "ok   train.py summary"
echo "ddp self-test passed"
../load/selftest.sh
