#!/usr/bin/env bash
# R8 — Checkpoint restore drill on the versioned checkpoint bucket (runbooks/data.md#checkpoints):
#   1. write a "good" marker <prefix>/<run>/latest, then a "bad save" over it;
#   2. find the good version (list-object-versions) and make it current again (copy-object of that
#      version: a new version, nothing deleted), read it back;
#   3. delete the marker (a delete marker becomes latest), restore the good version the same way;
#   4. remove every version and delete marker the drill wrote, so the bucket can still be emptied
#      and destroyed.
# Passes when both restores bring back the good content. Writes a few bytes; no cluster needed.
# Inputs: CKPT_BUCKET (`terraform -chdir=terraform/live/<stage>/data output -raw checkpoint_bucket`),
#         S3_ENDPOINT (`... output -raw s3_endpoint`), CKPT_PREFIX (default nip-restore-drill),
#         an access key of an identity that may write the bucket in AWS_ACCESS_KEY_ID /
#         AWS_SECRET_ACCESS_KEY (runbooks/data.md#credentials-access-keys-never-committed).
# shellcheck source=tests/validate/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"; need aws jq
B="${CKPT_BUCKET:-}"; EP="${S3_ENDPOINT:-}"; PREFIX="${CKPT_PREFIX:-nip-restore-drill}"
[[ -n "$B" && -n "$EP" ]] || { echo "set CKPT_BUCKET and S3_ENDPOINT (outputs checkpoint_bucket and s3_endpoint of the data root)" >&2; exit 2; }
s3() { aws --endpoint-url "$EP" s3api "$@"; }

# The drill proves the versioning safety net; on an unversioned bucket it would destroy the marker.
[[ "$(s3 get-bucket-versioning --bucket "$B" | jq -r '.Status // "Off"')" == Enabled ]] \
  || { echo "bucket ${B} is not versioned: the restore path does not exist (stacks/data enables versioning on the checkpoint bucket)" >&2; exit 2; }

run="$(date -u +%Y%m%dT%H%M%SZ)-$$"; key="${PREFIX}/${run}/latest"
tmp="$(mktemp -d)"
cleanup() { # every version and delete marker under the drill's run prefix
  s3 list-object-versions --bucket "$B" --prefix "${PREFIX}/${run}/" 2>/dev/null \
    | jq -r '((.Versions // []) + (.DeleteMarkers // []))[] | "\(.Key)\t\(.VersionId)"' \
    | while IFS=$'\t' read -r k v; do s3 delete-object --bucket "$B" --key "$k" --version-id "$v" >/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

put() { printf '%s' "$1" >"$tmp/body"; s3 put-object --bucket "$B" --key "$key" --body "$tmp/body" | jq -r '.VersionId'; }
current() { s3 get-object --bucket "$B" --key "$key" "$tmp/got" >/dev/null 2>&1 && cat "$tmp/got"; }
# restore <version>: copy that version over the key, as runbooks/data.md step 2; prints seconds taken.
restore() { local t0=$SECONDS; s3 copy-object --bucket "$B" --key "$key" --copy-source "${B}/${key}?versionId=$1" >/dev/null; echo $((SECONDS - t0)); }

good="checkpoint step=100 run=${run}"; bad="truncated save run=${run}"
good_v="$(put "$good")"
put "$bad" >/dev/null
# 1. the version written before the bad save, found by listing (as an operator would), not remembered:
#    the S3 API lists a key's versions newest first, so the first noncurrent one (LastModified has
#    one-second resolution, too coarse for two saves in a row; confirm the order on the first live drill)
found_v="$(s3 list-object-versions --bucket "$B" --prefix "$key" \
  | jq -r --arg k "$key" '[(.Versions // [])[] | select(.Key == $k and (.IsLatest | not))] | first | .VersionId // empty')"
over_s="$(restore "${found_v:-none}" 2>/dev/null || echo -1)"
after_over="$(current || true)"
# 2. a deleted marker: the delete marker is latest; copy the good version back again
s3 delete-object --bucket "$B" --key "$key" >/dev/null
deleted_gone="$([[ -z "$(current || true)" ]] && echo true || echo false)"
del_s="$(restore "$good_v" 2>/dev/null || echo -1)"
after_del="$(current || true)"

over_ok="$([[ "$found_v" == "$good_v" && "$after_over" == "$good" ]] && echo true || echo false)"
del_ok="$([[ "$deleted_gone" == true && "$after_del" == "$good" ]] && echo true || echo false)"
details="$(jq -n --arg b "$B" --arg k "$key" --argjson o "$over_ok" --argjson d "$del_ok" --argjson os "$over_s" --argjson ds "$del_s" \
  '{bucket:$b,key:$k,overwrite_restored:$o,delete_restored:$d,overwrite_restore_s:$os,delete_restore_s:$ds,
    method:"put good, put bad; list-object-versions -> newest noncurrent; copy-object ?versionId -> current; then delete-object and the same copy; drill versions removed afterwards"}')"
if [[ "$over_ok" == true && "$del_ok" == true ]]; then record checkpoint-restore pass "$details"; else record checkpoint-restore fail "$details"; fi
