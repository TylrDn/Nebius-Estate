#!/usr/bin/env bash
# NCCL log parsing shared by 03-nccl.sh and the fixture self-test (tests/validate/selftest.sh).
# nccl_parse <logfile>  -> one JSON object on stdout:
#   nccl_version      "NCCL version 2.x.y+cudaN" or ""
#   out_of_bounds_ok  true when nccl-tests printed "# Out of bounds values : 0 OK"
#   transport         ib | roce | socket | unknown. NCCL prints "NET/IB : Using [0]mlx5_0:1/IB" on
#                     InfiniBand and "... /RoCE" on a plain NIC (seen on a node with no GPU cluster),
#                     so the suffix decides, never the "NET/IB" prefix alone.
#   avg_bus_bandwidth_GBps  number or null
#   table             the per-size rows (bytes, time_us, algbw, busbw)
nccl_parse() {
  local log="$1" ver oob=false transport=unknown busbw table
  ver="$(grep -oE 'NCCL version [0-9.]+(\+cuda[0-9.]+)?' "$log" | head -1 || true)"
  grep -qE '# Out of bounds values : 0 OK' "$log" && oob=true
  if grep -qE 'NET/IB : Using .*/IB' "$log"; then transport=ib
  elif grep -qE 'NET/IB : Using .*/RoCE' "$log"; then transport=roce
  elif grep -qE 'NET/Socket' "$log"; then transport=socket; fi
  busbw="$(grep -E 'Avg bus bandwidth' "$log" | awk '{print $NF}' | tail -1 || true)"
  table="$(grep -vE 'NCCL INFO|^#|^$' "$log" | grep -E '^[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+' \
    | awk '{printf "{\"bytes\":%s,\"time_us\":%s,\"algbw_GBps\":%s,\"busbw_GBps\":%s},",$1,$6,$7,$8}' | sed 's/,$//' || true)"
  jq -n --arg v "${ver:-}" --argjson oob "$oob" --arg t "$transport" --argjson bw "${busbw:-null}" --argjson table "[${table}]" \
    '{nccl_version:$v,out_of_bounds_ok:$oob,transport:$t,avg_bus_bandwidth_GBps:$bw,table:$table}'
}

# nccl_bar <platform> -> one JSON object from nccl-bars.tsv (the docs' bar and any docs example
# for that GPU platform): {platform, min_busbw_GBps, source, docs_example_avg_busbw_GBps,
# example_source}. A platform not in the table gets null figures and says so.
nccl_bar() {
  local tsv row
  tsv="$(dirname "${BASH_SOURCE[0]}")/nccl-bars.tsv"
  row="$(awk -F'\t' -v p="$1" '!/^#/ && $1==p' "$tsv")"
  if [[ -z "$row" ]]; then
    jq -n --arg p "$1" '{platform:$p,min_busbw_GBps:null,source:"not listed in tests/validate/nccl-bars.tsv: no GPU-cluster figure in the docs",docs_example_avg_busbw_GBps:null,example_source:"unknown"}'
    return 0
  fi
  awk -F'\t' '{print $2; print $3; print $4; print $5}' <<<"$row" | jq -R . | jq -s --arg p "$1" \
    '{platform:$p,min_busbw_GBps:(.[0]|tonumber),source:.[1],docs_example_avg_busbw_GBps:(if .[2]=="-" then null else (.[2]|tonumber) end),example_source:.[3]}'
}
