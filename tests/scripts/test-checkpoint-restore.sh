#!/usr/bin/env bash
# tests/validate/checkpoint-restore.sh (R8 restore drill, runbooks/data.md#checkpoints): a good
# checkpoint marker, a bad save over it, the good version found and made current again, then the
# same after a delete; every drill version removed afterwards. `aws` is a stub that keeps a
# versioned bucket in a temp dir: no endpoint, no key.
# shellcheck disable=SC2016  # stub bodies are single-quoted on purpose: they expand when the stub runs
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export BUCKET_DIR="${work}/bucket"; mkdir -p "${BUCKET_DIR}"
stub aws '
exec python3 -I - "$@" <<"PY"
import json, os, sys, uuid
args = sys.argv[1:]
d = os.environ["BUCKET_DIR"]; db = os.path.join(d, "versions.json")
vers = json.load(open(db)) if os.path.exists(db) else []
def opt(name):
    return args[args.index(name) + 1] if name in args else None
def save(): json.dump(vers, open(db, "w"))
def current(key):
    live = [v for v in vers if v["key"] == key]
    return live[-1] if live else None
op = args[args.index("s3api") + 1]
key = opt("--key")
if op == "get-bucket-versioning":
    print(json.dumps({} if os.environ.get("VERSIONING_OFF") else {"Status": "Enabled"}))
elif op == "put-object":
    v = {"key": key, "vid": uuid.uuid4().hex, "body": open(opt("--body")).read(), "marker": False}
    vers.append(v); save(); print(json.dumps({"ETag": "\"x\"", "VersionId": v["vid"]}))
elif op == "list-object-versions":
    pre = opt("--prefix")
    sel = [v for v in vers if v["key"].startswith(pre)]
    latest = {v["key"]: v["vid"] for v in sel}
    out = {"Versions": [], "DeleteMarkers": []}
    for i, v in enumerate(reversed(sel)):
        e = {"Key": v["key"], "VersionId": v["vid"], "IsLatest": latest[v["key"]] == v["vid"], "LastModified": "2026-10-12T00:00:%02dZ" % (len(sel) - i)}
        out["DeleteMarkers" if v["marker"] else "Versions"].append(e)
    print(json.dumps(out))
elif op == "copy-object":
    src = opt("--copy-source"); path, _, q = src.partition("?versionId=")
    k = path.split("/", 1)[1]
    pick = [v for v in vers if v["key"] == k and (v["vid"] == q or (os.environ.get("IGNORE_VERSION_ID") and v is current(k)))]
    if not pick or pick[-1]["marker"]: sys.exit(254)
    nv = {"key": key, "vid": uuid.uuid4().hex, "body": pick[-1]["body"], "marker": False}
    vers.append(nv); save(); print(json.dumps({"VersionId": nv["vid"]}))
elif op == "get-object":
    c = current(key)
    if not c or c["marker"]: sys.exit(254)
    open(args[-1], "w").write(c["body"]); print(json.dumps({"VersionId": c["vid"]}))
elif op == "delete-object":
    vid = opt("--version-id")
    if vid:
        vers[:] = [v for v in vers if not (v["key"] == key and v["vid"] == vid)]; save(); print(json.dumps({"VersionId": vid}))
    else:
        m = {"key": key, "vid": uuid.uuid4().hex, "body": "", "marker": True}
        vers.append(m); save(); print(json.dumps({"DeleteMarker": True, "VersionId": m["vid"]}))
else:
    sys.exit(2)
PY'
export RESULTS_DIR="${work}/results" CKPT_BUCKET=nip-sandbox-checkpoints-mock S3_ENDPOINT=https://storage.example.invalid
drill() { set +e; env "$@" bash "${repo_root}/tests/validate/checkpoint-restore.sh" >"${work}/out" 2>&1; echo $?; set -e; }
result() { jq -r "$1" "${RESULTS_DIR}/checkpoint-restore.json"; }

test_name=checkpoint-restore-drill
rc="$(drill)"
[[ "${rc}" == 0 && "$(result .status)" == pass ]] || { cat "${work}/out" >&2; fail "the drill must pass against a versioned bucket (rc ${rc})"; }
[[ "$(result .details.overwrite_restored)" == true && "$(result .details.delete_restored)" == true ]] || fail "both restores recorded: $(result .details)"
grep -q 'copy-object .*--copy-source nip-sandbox-checkpoints-mock/nip-restore-drill/.*/latest?versionId=' "${LOG}" || fail "restore is a copy of the old version (runbooks/data.md)"
grep -q -- '--endpoint-url https://storage.example.invalid' "${LOG}" || fail "S3_ENDPOINT not used"
[[ "$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "${BUCKET_DIR}/versions.json")" == 0 ]] \
  || fail "the drill must remove every version and delete marker it wrote"
ok "overwrite and delete restored from the noncurrent version; drill objects removed"

test_name=checkpoint-restore-wrong-version
rc="$(drill IGNORE_VERSION_ID=1)"
[[ "${rc}" != 0 && "$(result .status)" == fail && "$(result .details.overwrite_restored)" == false ]] \
  || fail "a restore that brings back the bad save must fail (rc ${rc})"
ok "restoring the wrong content fails the drill"

test_name=checkpoint-restore-needs-versioning
: > "${LOG}"
rc="$(drill VERSIONING_OFF=1)"
[[ "${rc}" == 2 ]] || fail "an unversioned bucket is refused before writing (rc ${rc})"
grep -q 'put-object' "${LOG}" && fail "nothing is written to an unversioned bucket"
rc="$(drill CKPT_BUCKET=)"
[[ "${rc}" == 2 ]] || fail "CKPT_BUCKET is required (rc ${rc})"
ok "refuses without versioning or a bucket"
