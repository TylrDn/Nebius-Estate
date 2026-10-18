# shellcheck shell=bash
# fio JSON parser for 03-storage.sh (sourced; needs jq). The run is `--group_reporting` with a write
# group and a `--stonewall` read group, so fio reports one entry per group that already sums the
# parallel jobs; entries are matched by their rw option, never by position.
#   fio_summary <fio --output-format=json file>
#     -> {"write_MiBps":N,"read_MiBps":N,"fio_errors":N,"fio_version":"fio-x.y","numjobs":N}
# Output that is not fio JSON (a failed pod, an empty answer) reads as zero throughput with one error.
fio_summary() {
  jq -c '{
      write_MiBps: ([.jobs[]? | select(."job options".rw == "write") | .write.bw_bytes] | add // 0 | . / 1048576 | floor),
      read_MiBps:  ([.jobs[]? | select(."job options".rw == "read")  | .read.bw_bytes]  | add // 0 | . / 1048576 | floor),
      fio_errors:  ([.jobs[]?.error] | add // 1),
      fio_version: (."fio version" // null),
      numjobs:     ((."global options".numjobs // "1") | tonumber)
    }' "$1" 2>/dev/null \
    || echo '{"write_MiBps":0,"read_MiBps":0,"fio_errors":1,"fio_version":null,"numjobs":0}'
}
