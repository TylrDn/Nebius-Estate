#!/usr/bin/env bash
# DDP log parsing shared by ddp.sh and the fixture self-test (tests/validate/selftest.sh).
# ddp_parse <logfile> -> one JSON object on stdout: the rank-0 summary line that
# workloads/training/ddp/train.py prints (world_size, batch_per_rank, step_ms_p50, samples_per_s,
# versions), plus found (false when the job never printed it) and the NCCL transport seen in the
# log (lib-nccl.sh rules: ib | roce | socket | unknown).
ddp_parse() {
  local log="$1" line transport=unknown
  line="$(grep -E '^\{.*"samples_per_s"' "$log" | tail -1 || true)"
  if grep -qE 'NET/IB : Using .*/IB' "$log"; then transport=ib
  elif grep -qE 'NET/IB : Using .*/RoCE' "$log"; then transport=roce
  elif grep -qE 'NET/Socket' "$log"; then transport=socket; fi
  if [[ -n "$line" ]] && jq -e . >/dev/null 2>&1 <<<"$line"; then
    jq --arg t "$transport" '. + {found:true,transport:$t}' <<<"$line"
  else
    jq -n --arg t "$transport" '{found:false,samples_per_s:null,transport:$t}'
  fi
}
