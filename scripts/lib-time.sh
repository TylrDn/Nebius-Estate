# shellcheck shell=bash
# UTC time helpers for scripts that compare against a label or a recorded date (sourced; defines
# functions only). macOS `date -j -f` reads a time as local unless TZ says otherwise: on 2026-10-11 a
# teardown scheduled from a nip-ttl-expires label started late because of it
# (docs/evidence/2026-10-11-sandbox-inference-populate.md). Every parse here runs with TZ=UTC.
#
#   nip_epoch <YYYY-MM-DDTHH:MM:SSZ | YYYY-MM-DD>   seconds since the epoch (a date is 00:00:00Z)
#   nip_utc <epoch>                                 YYYY-MM-DDTHH:MM:SSZ
#   nip_now                                         now in epoch seconds; NIP_NOW overrides it (tests)

nip_epoch() {
  local t="$1"
  [[ "${t}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && t="${t}T00:00:00Z"
  [[ "${t}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    echo "not a UTC time: '$1' (expected YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD)" >&2; return 1; }
  if date -u -d @0 >/dev/null 2>&1; then
    TZ=UTC date -u -d "${t}" +%s
  else
    TZ=UTC date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "${t}" +%s
  fi
}

nip_utc() {
  if date -u -d @0 >/dev/null 2>&1; then
    TZ=UTC date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
  else
    TZ=UTC date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
  fi
}

nip_now() { echo "${NIP_NOW:-$(date -u +%s)}"; }
