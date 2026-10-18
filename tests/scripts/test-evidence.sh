#!/usr/bin/env bash
# Evidence hygiene (docs/evidence/README.md "What is committed"):
#   1. scripts/scrub-evidence.py replaces every Nebius resource id in a run's output with a
#      placeholder and --check finds what it would replace;
#   2. nothing committed under docs/evidence/ (but raw/, the upstream runs' verbatim output) or
#      results/ carries an id of that shape;
#   3. every dated evidence file has a Kind header and a row in the docs/evidence/README.md index;
#   4. the README "What is proven" level table does not say "No recipe yet" once a row is Measured.
# shellcheck source=tests/scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
scrub="${repo_root}/scripts/scrub-evidence.py"

test_name="scrub-replaces-ids"
# Shapes seen in the 2026-10-12 run output (values here are made up, the shapes are real): a typed id,
# a kube context ending in the cluster id, a registry path segment, a bucket suffix cut from the
# project id, MSP hostnames, the state bucket's hex suffix. A pinned git revision is not an id.
cat > "${work}/in.json" <<'EOF'
{"context": "nebius-mk8s-nip-sandbox-inference-e00mockclusterx01",
 "node": "computeinstance-e00mockinstancex2",
 "image": "cr.eu-north1.nebius.cloud/e00mockregistryx3/nip-check:20261012193215",
 "bucket": "nip-sandbox-checkpoints-e00mockproj0",
 "host": "private-tracking.mlflow-e00mockmlflowxx04.backbone-e00mockbackbone05.msp.eu-north1.nebius.cloud",
 "state": "tfstate-nip-sandbox-0123456789ab",
 "digest": "sha256:e00b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e",
 "revision": "a09a35458c702b33eeacc393d103063234e8bc28",
 "kernel": "6.11.0-1016-nvidia", "run": "20261012T193748Z-63936"}
EOF
python3 "${scrub}" "${work}/in.json" > "${work}/out.json" || fail "scrub exited non-zero"
for want in 'inference-<id>"' 'computeinstance-<id>"' 'nebius.cloud/<id>/nip-check:20261012193215' \
            'checkpoints-<id>"' 'mlflow-<id>.backbone-<id>.msp' 'tfstate-nip-sandbox-<hex>"' \
            'sha256:e00b7f3d86d6' 'a09a35458c702b33' '6.11.0-1016-nvidia' '20261012T193748Z-63936'; do
  grep -qF -- "${want}" "${work}/out.json" || { cat "${work}/out.json" >&2; fail "expected ${want} in the scrubbed output"; }
done
grep -q 'e00mock' "${work}/out.json" && fail "an id survived the scrub"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "${work}/out.json" || fail "scrubbed JSON no longer parses"
ok "typed ids, registry paths, bucket suffixes, MSP hosts and the state-bucket suffix become placeholders; digests, revisions and versions stay"

test_name="scrub-check"
python3 "${scrub}" --check "${work}/out.json" >/dev/null || fail "--check flags the scrubbed file"
out="$(python3 "${scrub}" --check "${work}/in.json" 2>&1)" && fail "--check passed a file with ids"
grep -q 'in.json' <<<"${out}" || fail "--check does not name the file: ${out}"
grep -q 'e00mock' <<<"${out}" && fail "--check printed the id it found: ${out}"
ok "--check fails on ids, names the file and line, never prints the id"

test_name="scrub-foreign-context"
# A step run while kubectl pointed at a context other than the session's Nebius cluster records that
# context's name, which is not id-shaped but is not ours to publish: any "context" that is not a
# `nebius-mk8s-…` context becomes a placeholder, and --check flags it.
printf '{"step": "x",\n  "context": "someones-other-lab",\n  "ok": "nebius-mk8s-nip-sandbox-inference-<id>"}\n' > "${work}/ctx.json"
python3 "${scrub}" "${work}/ctx.json" > "${work}/ctx-out.json" || fail "scrub exited non-zero"
grep -qF '"context": "<unrelated-context>"' "${work}/ctx-out.json" || { cat "${work}/ctx-out.json" >&2; fail "a foreign kube context survived the scrub"; }
out="$(python3 "${scrub}" --check "${work}/ctx.json" 2>&1)" && fail "--check passed a foreign kube context"
grep -q 'someones-other-lab' <<<"${out}" && fail "--check printed the context it found: ${out}"
printf '{"context": "nebius-mk8s-nip-sandbox-inference-<id>"}\n{"context": "<unrelated-context>"}\n' > "${work}/ctx-ok.json"
python3 "${scrub}" --check "${work}/ctx-ok.json" >/dev/null || fail "--check flags a session context or the placeholder"
ok "a kube context other than the session's Nebius cluster becomes <unrelated-context>"

# committed_evidence_files ROOT: what may be committed, without git (the toolbox mounts a worktree
# whose .git points outside it): docs/evidence/*.md and results/<subdir>/*, except results/private/
# and *.state. Exclusions are anchored at ROOT: a checkout under a path containing /private/ (every
# macOS /tmp worktree is under /private/tmp) must not drop the results files.
committed_evidence_files() {
  local root="$1"
  find "${root}/docs/evidence" -maxdepth 1 -name '*.md'
  find "${root}/results" -mindepth 2 -type f -not -path "${root}/results/private/*" -not -name '*.state' 2>/dev/null
}

test_name="evidence-files-anchored"
fake="${work}/private/tmp/repo"
mkdir -p "${fake}/docs/evidence" "${fake}/results/2026-01-01" "${fake}/results/private/x"
touch "${fake}/docs/evidence/a.md" "${fake}/results/2026-01-01/r.json" "${fake}/results/2026-01-01/t.state" \
      "${fake}/results/private/x/p.json"
got="$(committed_evidence_files "${fake}" | sed "s|^${fake}/||" | sort | tr '\n' ' ')"
[[ "${got}" == "docs/evidence/a.md results/2026-01-01/r.json " ]] || fail "from a root under /private/: got '${got}'"
ok "the file list is anchored at the repository, so a checkout under /private/ still scans results/"

test_name="committed-evidence-has-no-ids"
files=()
while IFS= read -r f; do files+=("${f#"${repo_root}"/}"); done < <(committed_evidence_files "${repo_root}")
(( ${#files[@]} > 0 )) || fail "no evidence files found"
n_results=0
for f in "${files[@]}"; do [[ "${f}" == results/* ]] && n_results=$((n_results + 1)); done
if compgen -G "${repo_root}/results/20[0-9][0-9]-*/*" >/dev/null && (( n_results == 0 )); then
  fail "results/<date>/ holds files but none were scanned"
fi
(cd "${repo_root}" && python3 "${scrub}" --check "${files[@]}") || fail "a committed evidence file carries a resource id (run scripts/scrub-evidence.py on it)"
ok "$(( ${#files[@]} - n_results )) docs/evidence files carry no resource id"
ok "${n_results} results/<date>/ files carry no resource id"

test_name="evidence-index"
readme="${repo_root}/docs/evidence/README.md"
n=0
for f in "${repo_root}"/docs/evidence/20[0-9][0-9]-*.md; do
  b="$(basename "${f}")"
  grep -qE '^- (\*\*)?Kind:?(\*\*)?' "${f}" || fail "${b}: no '- **Kind:**' header"
  grep -qE "^\| \[\`${b}\`\]\(${b}\) \|" "${readme}" || fail "${b}: no row in docs/evidence/README.md"
  n=$((n + 1))
done
ok "${n} dated evidence files carry a Kind header and an index row"

test_name="measured-level"
if grep -qE '^\| \*\*R[0-9]+\*\* \| Measured \|' "${repo_root}/README.md"; then
  grep -qE '^\| \*\*Measured\*\* \|.*No recipe yet' "${repo_root}/README.md" \
    && fail "README says no recipe is Measured, but a row is"
fi
ok "the Measured level's description agrees with the rows"

test_name="raw-results-ignored"
# Raw step output at the top of results/ carries real ids and stays local; scrubbed copies under
# results/<date>/ are committed (docs/evidence/README.md "What is committed").
gi="${repo_root}/.gitignore"
for pat in '/results/*.json' '/results/*.log'; do
  grep -qxF -- "${pat}" "${gi}" || fail "${pat}: raw output is not git-ignored"
done
grep -qxE '/?results(/|/\*|/\*\*|/\*/|/20[0-9-]*/?)?' "${gi}" && fail "a .gitignore line ignores results/<date>/ copies"
ok "raw results/ output is ignored, scrubbed results/<date>/ copies are not"
