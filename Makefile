SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

# Lifecycle targets act on one live root: terraform/live/$(STAGE)/$(STACK) (ADR-0009).
# Stages: sandbox | staging | prod | lab (platform/stages.yaml; lab renders only the stacks it lists). Stacks: network | data | inference | training | gpu-vm | ml-services | governance | nvl
# (gpu-vm has no prod root: max_gpu_nodes.gpu-vm is 0 there; nvl has no root in any stage until max_gpu_nodes.nvl is raised)
# (soperator wraps the upstream recipe: soperator-check / soperator-plan / soperator-apply).
# The foundation root is STAGE=foundation.
STAGE ?= sandbox
STACK ?= inference
# The foundation root has no stack dimension: STAGE=foundation (STACK is ignored).
STACK_NAME := $(if $(filter foundation,$(STAGE)),foundation,$(STACK))
TF_DIR := $(if $(filter foundation,$(STAGE)),terraform/live/foundation,terraform/live/$(STAGE)/$(STACK))
BOOT_ARGS := $(STAGE) $(STACK_NAME)
TF := terraform -chdir=$(TF_DIR)
PLAN := $(STAGE)-$(STACK_NAME).tfplan
SOPERATOR_STAGES := sandbox staging prod lab
# The Soperator recipe needs Terraform >= 1.12; the toolbox ships it as terraform-soperator.
# The recipe at the pinned tag declares data.nebius_iam_v1_project and data.nebius_iam_v1_tenant (the second
# unused), both on v1 APIs supported until 2026-12-16 (docs/upstream-findings.md R4-14).
# terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff removes them (owner decision
# 2026-10-13, docs/plans/2026-10-13-soperator-options.md); soperator-check fails whenever the
# patched tree still declares either, so a new tag, a dropped patch or an override cannot bring them back.
TERRAFORM_SOPERATOR ?= terraform
SOPERATOR_DIR := terraform/stacks/soperator/upstream/soperator/installations/example
SOPERATOR_VARS = -var-file=terraform.tfvars -var-file=$(CURDIR)/terraform/stacks/soperator/profiles/lab.tfvars \
  -var-file=$(CURDIR)/terraform/live/$(1)/soperator/stage.tfvars
# Toolbox image: every pinned tool from platform/versions.yaml (tools/toolbox/Dockerfile).
TOOLBOX ?= nip-toolbox
# TOOLBOX_ENV names extra variables to pass through (the pipeline sets it:
# .github/actions/nebius-stage-setup); TOOLBOX_HOME mounts a host directory as the toolbox home,
# for example to keep a local CLI profile between runs. The pipeline keeps no CLI profile.
TOOLBOX_ENV ?=
TOOLBOX_HOME ?=
DOCKER_RUN = docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/repo" -v nip-tf-cache:/cache/terraform \
  $(if $(TOOLBOX_HOME),-v "$(TOOLBOX_HOME):/tmp/home") -e GITHUB_TOKEN $(addprefix -e ,$(TOOLBOX_ENV)) $(TOOLBOX)

.PHONY: help ci plan-summary docs-catalog docs-check docs-links md-links env-status ci-docker toolbox pins fmt fmt-check validate lint test policy scan scan-secrets scan-config release-regressions links soperator-check shellcheck selftest \
        kustomize recipes-check render-live render-live-check compat-matrix compat-matrix-check \
        bootstrap preflight init plan show-plan plan-digest apply destroy-plan destroy ttl-teardown output kubeconfig validate-cluster leftovers leftovers-stage quota-check \
        soperator-plan soperator-apply soperator-destroy-plan soperator-destroy \
        doctor portal-demo portal-install portal-dev portal-test portal-e2e portal-verify-live portal-build

help: ## Show targets, grouped by section
	@grep -E '^([a-zA-Z0-9_-]+:.*## |## --- )' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*## "} /^## --- /{sub(/^## --- /,""); sub(/ -+$$/,""); printf "\n%s\n",$$0; next} {printf "  %-20s %s\n",$$1,$$2}'

## --- Static checks (no credentials, no spend) ---------------------------------

ci: pins fmt-check render-live-check compat-matrix-check docs-links md-links validate lint test policy shellcheck selftest recipes-check kustomize ## Every offline check CI runs (CI adds soperator-check, scan, links)

toolbox: ## Build the pinned toolbox image (linux/amd64) from platform/versions.yaml
	docker build --platform linux/amd64 $$(python3 scripts/pins.py build-args) -t $(TOOLBOX) tools/toolbox

ci-docker: ## Run TARGETS (default: ci) inside the toolbox image, e.g. make ci-docker TARGETS="ci soperator-check scan"
	$(DOCKER_RUN) make $(or $(TARGETS),ci)

pins: ## Every image, action and script default is pinned to platform/versions.yaml
	python3 scripts/pins.py check

fmt: ## Format all Terraform
	terraform fmt -recursive terraform

fmt-check: ## Fail when any Terraform file is not formatted (part of ci)
	terraform fmt -check -recursive -diff terraform

# Every root with its own providers: the stacks, the foundation root, the rendered live roots
# and the modules that carry a lock file (the ones with mocked tests; the others are validated
# through the stacks that call them). terraform/stacks/soperator wraps the upstream recipe
# (soperator-check); a tests/ directory is not a root.
# Offline checks keep their own Terraform data dir (.terraform/check, inside the git-ignored
# .terraform/): a live `init` leaves .terraform/terraform.tfstate pointing at the S3 backend, and
# `init -backend=false` on that dir still configures the saved backend, so it asks for cloud
# credentials and fails offline. Separate dirs mean a live run can never break the offline checks,
# and the checks never touch a live root's backend. A failed init stops the target (|| exit 1).
TF_CHECK := TF_DATA_DIR=.terraform/check
# Git-ignored *_override.tf and terraform.tfvars files (a live run's labels, a destroy provider pin,
# an operator's real inputs) change what the checks see; name them so a result is never silently
# about a local file.
NOTE_OVERRIDES = for o in $$root*_override.tf $${root}terraform.tfvars; do [[ -e "$$o" ]] && echo "Note: $$o is a local, git-ignored file; this result includes it"; done; true
TF_ROOTS := terraform/stacks/*/ terraform/live/foundation/ terraform/live/*/*/ terraform/modules/*/ terraform/modules/foundation/*/
SKIP_ROOT = [[ "$$root" == */soperator/ || "$$root" == */tests/ ]] && continue; [[ "$$root" == terraform/modules/* && ! -f "$$root.terraform.lock.hcl" ]] && continue

validate: ## init -backend=false + validate every root (stacks, live, foundation, modules)
	@for root in $(TF_ROOTS); do \
	  $(SKIP_ROOT); \
	  echo "== $$root"; $(NOTE_OVERRIDES); \
	  $(TF_CHECK) terraform -chdir=$$root init -backend=false -input=false -lockfile=readonly >/dev/null || exit 1; \
	  $(TF_CHECK) terraform -chdir=$$root validate || exit 1; \
	done

lint: ## tflint (recommended preset)
	scripts/tflint.sh

test: ## terraform test with mocked providers (plan only) in every root that has tests/
	@for root in $(TF_ROOTS); do \
	  $(SKIP_ROOT); \
	  if compgen -G "$$root/tests/*.tftest.hcl" >/dev/null; then \
	    echo "== $$root"; $(NOTE_OVERRIDES); $(TF_CHECK) terraform -chdir=$$root init -backend=false -input=false -lockfile=readonly >/dev/null || exit 1; $(TF_CHECK) terraform -chdir=$$root test || exit 1; \
	  fi; \
	done

render-live: ## Re-render terraform/live/<stage>/<stack> and the stage-policy table (platform/README.md) from platform/stages.yaml
	python3 scripts/render-live-roots.py

render-live-check: ## Fail when the rendered live roots or the stage-policy table are stale
	python3 scripts/render-live-roots.py --check

policy: ## conftest (OPA): rule unit tests, stage policy, prod sizing, Soperator prod, allowlists and CPU sizing in every sizing file, R16 Kueue manifests per stage (policy/README.md)
	conftest verify --policy policy
	conftest test --policy policy --namespace stages platform/stages.yaml
	conftest test --policy policy --namespace prod --parser hcl2 terraform/live/prod/*/prod.auto.tfvars
	conftest test --policy policy --namespace soperator_prod --parser hcl2 terraform/live/prod/soperator/stage.tfvars
	conftest test --policy policy --namespace allowlists --parser hcl2 terraform/live/*/*/*.tfvars
	conftest test --policy policy --namespace sizing --parser hcl2 terraform/live/*/*/*.tfvars
	@tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; kubectl kustomize workloads/kueue/sample-job > "$$tmp/job.yaml"; \
	for s in sandbox staging prod; do \
	  kubectl kustomize workloads/kueue/overlays/$$s > "$$tmp/$$s.yaml"; \
	  echo "== kueue $$s"; conftest test --combine --policy policy --namespace kueue platform/stages.yaml "$$tmp/$$s.yaml" "$$tmp/job.yaml"; \
	done

scan: scan-secrets scan-config ## History secrets + HIGH/CRITICAL configuration checks

scan-secrets: ## Scan all fetched history; print redacted rule/path/fingerprint diagnostics
	scripts/scan-secrets.sh

scan-config: ## Trivy HIGH/CRITICAL configuration scan (network for check bundle)
	trivy config --quiet --exit-code 1 --severity HIGH,CRITICAL --ignorefile .trivyignore.yaml \
	  --skip-dirs docs/evidence/raw --skip-dirs portal/node_modules --skip-dirs terraform/stacks/soperator/upstream .

# github.com throttles anonymous link checks: borrow the gh CLI's token for these two targets only
# (never written to .env or a file; an explicit GITHUB_TOKEN wins).
links ci-docker: export GITHUB_TOKEN := $(or $(GITHUB_TOKEN),$(shell gh auth token 2>/dev/null))
# console.nebius.com and Token Factory console pages answer 403 without a login; docs.nebius.com is checked
# offline by docs-links against the committed catalog.
links: ## lychee over every Markdown file (network; uses the gh CLI token when GITHUB_TOKEN is unset)
	lychee --no-progress --max-retries 4 --retry-wait-time 10 --accept 200,204,429 \
	  --exclude-path node_modules --exclude-path terraform/stacks/soperator/upstream --exclude 'docs.nebius.com' --exclude 'console.nebius.com' --exclude 'tokenfactory.nebius.com/(project|organization)' './**/*.md'

soperator-check: ## Soperator recipe at the pinned tag plus patches/: fmt, no v1 IAM data sources, validate, mocked plan per stage ($(TERRAFORM_SOPERATOR) >= 1.12)
	$(TERRAFORM_SOPERATOR) fmt -check -diff terraform/stacks/soperator/profiles terraform/live/*/soperator
	scripts/fetch-soperator.sh --no-backend
	@if grep -nE 'nebius_iam_v1_(project|tenant)' $(SOPERATOR_DIR)/*.tf >&2; then \
	  echo "Error: the patched Soperator recipe still declares or reads data.nebius_iam_v1_project / nebius_iam_v1_tenant (lines above), whose v1 API support ends 2026-12-16; terraform/stacks/soperator/patches/0001-drop-iam-v1-data-sources.diff must remove them (docs/upstream-findings.md R4-14, terraform/stacks/soperator/README.md#patches)" >&2; exit 1; \
	fi
	@echo "ok: no nebius_iam_v1_project / nebius_iam_v1_tenant in the patched recipe (patches/0001; drop it at the first upstream tag without them)"
	@cd $(SOPERATOR_DIR) && export $(TF_CHECK) && \
	  $(TERRAFORM_SOPERATOR) init -backend=false -input=false -lockfile=readonly >/dev/null && $(TERRAFORM_SOPERATOR) validate && \
	  for stage in $(SOPERATOR_STAGES); do \
	    echo "== soperator stage $$stage"; \
	    $(TERRAFORM_SOPERATOR) test -test-directory=tests-nip $(call SOPERATOR_VARS,$$stage) \
	      -var iam_merge_request_url=https://example.invalid/mr/1; \
	  done

shellcheck: ## shellcheck all scripts
	shellcheck -x scripts/*.sh scripts/live/*.sh scripts/live/bin/aws tests/load/*.sh tests/validate/*.sh tests/scripts/*.sh workloads/inference/*.sh workloads/training/*.sh workloads/kueue/*.sh recipes/serverless/*.sh recipes/token-factory/*.sh recipes/observability/*.sh

# Bases and components are only built through the overlays that use them; an empty set is a bug.
kustomize: ## kubectl kustomize every kustomization under workloads/ and recipes/ (except base/ and components/)
	@dirs=$$(find workloads recipes -name kustomization.yaml -not -path '*/base/*' -not -path '*/components/*' -exec dirname {} \; | sort); \
	test -n "$$dirs" || { echo "no kustomizations found"; exit 1; }; \
	for k in $$dirs; do echo "== $$k"; kubectl kustomize "$$k" >/dev/null; done

selftest: ## Fixture self-test for the NCCL log parser; operational scripts against stub CLIs (tests/scripts, offline)
	tests/validate/selftest.sh
	tests/scripts/run.sh

release-regressions: ## Focused source-retention, scan-privacy, deployment-input, host-benchmark and storage regressions
	@rc=0; for t in test-fetch-soperator-patches test-scan-secrets test-bench test-stage-setup-vars; do \
	  bash "tests/scripts/$$t.sh" || rc=1; \
	done; \
	if $(TF_CHECK) terraform -chdir=terraform/modules/o11y init -backend=false -input=false -lockfile=readonly >/dev/null; then \
	  $(TF_CHECK) terraform -chdir=terraform/modules/o11y test || rc=1; \
	else rc=1; fi; exit $$rc

# Script recipes without Terraform: offline only (no token, no key, no network, no spend).
recipes-check: ## R9 price.py --dry-run on the example footprints; R11 smoke.py dry run and refusals; R14 dry runs and refusals (recipes/observability/test.sh); R16 Kueue install --dry-run
	@for f in recipes/finance/examples/*; do echo "== price.py --dry-run $$f"; env -u NEBIUS_IAM_TOKEN PYTHONDONTWRITEBYTECODE=1 python3 recipes/finance/price.py "$$f" --project project-e00example --dry-run >/dev/null; done
	recipes/token-factory/test.sh
	recipes/observability/test.sh
	workloads/kueue/install.sh --dry-run

compat-matrix: ## Regenerate docs/compatibility-matrix.md from platform/versions.yaml
	python3 scripts/render-compat-matrix.py

compat-matrix-check: ## Fail when docs/compatibility-matrix.md is stale
	python3 scripts/render-compat-matrix.py --check

docs-links: ## Offline: every docs.nebius.com link and #anchor in the repo exists in the committed catalog
	python3 scripts/nebius-docs.py check --offline

md-links: ## Offline: every relative Markdown link resolves to a file, and every #anchor to a heading (GitHub slugs)
	python3 scripts/md-links.py

## --- Docs catalog and local credentials (network or local files; no spend) -----

docs-catalog: ## Re-crawl docs.nebius.com into docs/reference/nebius-docs.{json,md} (network; raw pages cached in .cache/)
	python3 scripts/nebius-docs.py crawl

docs-check: ## Upstream docs drift (changed/new/removed pages, redirects) + every docs.nebius.com link in the repo resolves
	python3 scripts/nebius-docs.py check

env-status: ## Which credential slots from .env.example are set (never prints values); checks .env/secrets/ are private; warns 14 days before a CI key expiry in platform/ci-keys.yaml; LIVE=1 also proves the keys work and are not near expiry
	scripts/env-status.sh $(if $(LIVE),--live)

## --- Lifecycle (needs credentials; apply/destroy need CONFIRM=yes) ------------

bootstrap: ## Print how to bootstrap remote state (must be sourced)
	@echo "Run:  source scripts/bootstrap-backend.sh $(BOOT_ARGS)"

# One go/no-go before make plan: key expiries, this plan's quota demand (quota-plan.py --json), capacity advice, region/platform and
# spot-cap pairs, stage caps and the TTL (scripts/preflight.py). OFFLINE=1 makes no cloud call (quota and
# capacity skipped, said so); FIXTURES=<dir> reads them from files (tests/scripts/fixtures/preflight).
preflight: ## Go/no-go for $(STAGE)/$(STACK) before make plan (PROFILE=<name>; OFFLINE=1: no cloud calls; FIXTURES=<dir>: recorded inputs)
	python3 scripts/preflight.py --stage $(STAGE) --stack $(STACK_NAME) $(if $(PROFILE),--profile $(PROFILE)) $(if $(OFFLINE),--offline) $(if $(FIXTURES),--fixtures $(FIXTURES))

# -reconfigure: backend.hcl is rewritten by every bootstrap and is the only source of truth for
# where this root's state lives. Without it, a .terraform/ left by an init against another bucket
# stops init ("Backend configuration changed") or offers to copy state between buckets, which must
# never happen implicitly. The stage binding in bootstrap-backend.sh stops a wrong target first.
init: ## terraform init with the generated backend.hcl
	@test -d $(TF_DIR) || { echo "No such live root $(TF_DIR): STAGE=sandbox|staging|prod|lab STACK=network|data|inference|training|gpu-vm|ml-services|governance|nvl (or STAGE=foundation)"; exit 1; }
	@test -f $(TF_DIR)/backend.hcl || { echo "Missing $(TF_DIR)/backend.hcl: source scripts/bootstrap-backend.sh $(BOOT_ARGS) first"; exit 1; }
	$(TF) init -input=false -reconfigure -backend-config=backend.hcl

# PLAN_LOCK=false plans without the state lock: the pipeline's plan job holds a read-only state key
# (storage.object-viewer), which cannot write the lock file. Its apply job re-plans under the lock.
# PLAN_LOG=false keeps the plan's diff (attribute values) out of the log; errors still print.
PLAN_LOCK ?= true
PLAN_LOG ?= true
# PROFILE=<name> plans with a committed run profile (platform/profiles/<stack>/<name>.json): its inputs
# plus generated nip-run (RUN=) and nip-ttl-expires (TTL_HOURS=, from now, UTC) labels, rendered by
# scripts/run-profile.py to the root's git-ignored .run-profile.tfvars.json and passed as -var-file.
# destroy-plan reuses that file, so the teardown sees the inputs the run was planned with. RUN_PROFILE=1
# passes the root's already-rendered file without naming the profile (make ttl-teardown's job uses it).
PROFILE ?=
PROFILE_VARS := .run-profile.tfvars.json
PROFILE_ARG = $(if $(or $(PROFILE),$(RUN_PROFILE)),-var-file=$(PROFILE_VARS))
RENDER_PROFILE = python3 scripts/run-profile.py --stage $(STAGE) --stack $(STACK_NAME) --profile $(PROFILE) $(if $(RUN),--run $(RUN)) $(if $(TTL_HOURS),--ttl-hours $(TTL_HOURS)) --out $(TF_DIR)/$(PROFILE_VARS)
plan: ## Save a plan to $(STAGE)-$(STACK).tfplan and print its summary; run make preflight first (PROFILE=<name>: a committed run profile; PLAN_LOCK=false: no state lock; PLAN_LOG=false: no diff in the log)
	$(if $(PROFILE),$(RENDER_PROFILE))
	$(TF) plan -input=false -lock=$(PLAN_LOCK) $(PROFILE_ARG) -out=$(PLAN) $(if $(filter false,$(PLAN_LOG)),>/dev/null)
	$(TF) show -no-color $(PLAN) | grep -E '^Plan:|No changes' || true

show-plan: ## Print the saved plan (sensitive values redacted by terraform)
	@$(TF) show -no-color $(PLAN)

plan-summary: ## Counts and addresses of the saved plan's resource changes, without attribute values (the pipeline's job summary)
	@$(TF) show -json $(PLAN) | jq -r '[.resource_changes[]? | select(.change.actions != ["no-op"]) | {address, action: (.change.actions | join("+"))}] as $$c | "Changes: \($$c | length) (" + ([$$c | group_by(.action)[] | "\(.[0].action) \(length)"] | join(", ")) + ")", ($$c[] | "  \(.action)  \(.address)")'

plan-digest: ## sha256 of the saved plan's resource changes (the pipeline's apply re-plans and must match it)
	@$(TF) show -json $(PLAN) | jq -S '[.resource_changes[]? | {address, actions: .change.actions, after: .change.after}]' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1

apply: ## Apply the saved plan (CONFIRM=yes required)
	@test "$(CONFIRM)" = "yes" || { echo "Refusing: set CONFIRM=yes after reviewing $(PLAN) (runbooks/deploy.md)"; exit 1; }
	scripts/tf-run.sh $(TF_DIR) $(PLAN)

# A destroy plan sees the cluster outputs as null, so helm/kubernetes/kubectl would dial localhost while
# refreshing in-cluster resources: pin them to the endpoint in state first (zz_destroy_override.tf,
# git-ignored; written only when the state has a cluster and in-cluster resources; runbooks/teardown.md).
destroy-plan: ## Save a destroy plan and print its summary (refused for STAGE=prod); pins the k8s providers to the cluster in state first
	@test "$(STAGE)" != "prod" || { echo "Refusing: prod is torn down through the release process, not make (runbooks/teardown.md)"; exit 1; }
	scripts/destroy-providers-override.sh --dir $(TF_DIR)
	$(if $(PROFILE),test -f $(TF_DIR)/$(PROFILE_VARS) || $(RENDER_PROFILE))
	$(TF) plan -destroy -input=false $(PROFILE_ARG) -out=destroy.tfplan
	$(TF) show -no-color destroy.tfplan | grep -E '^Plan:|No changes' || true

destroy: ## Apply the saved destroy plan (CONFIRM=yes required; refused for STAGE=prod)
	@test "$(STAGE)" != "prod" || { echo "Refusing: prod is torn down through the release process, not make (runbooks/teardown.md)"; exit 1; }
	@test "$(CONFIRM)" = "yes" || { echo "Refusing: set CONFIRM=yes after reviewing destroy.tfplan (runbooks/teardown.md)"; exit 1; }
	scripts/tf-run.sh $(TF_DIR) destroy.tfplan
	scripts/destroy-providers-override.sh --dir $(TF_DIR) --remove

# Safety net for a TTL-bound run: at nip-ttl-expires (parsed as UTC whatever the local TZ) a background
# job runs destroy-plan then destroy CONFIRM=yes for this root (scripts/ttl-teardown.sh, runbooks/teardown.md).
ttl-teardown: ## Schedule $(STAGE)/$(STACK)'s teardown at its nip-ttl-expires and print the UTC time (TTL=YYYY-MM-DDTHH:MM:SSZ overrides; PROFILE=<name> as planned; CONFIRM=yes; DRY=1 only prints)
	scripts/ttl-teardown.sh --stage $(STAGE) --stack $(STACK_NAME) $(if $(TTL),--expires $(TTL)) $(if $(PROFILE),--profile $(PROFILE)) $(if $(DRY),--dry-run)

output: ## Show non-sensitive outputs
	$(TF) output

kubeconfig: ## Fetch kubeconfig for $(STAGE)/$(STACK) from Terraform outputs
	scripts/get-kubeconfig.sh $(STAGE) $(STACK)

validate-cluster: ## Bottom-up validation of the inference cluster (WITH_LOAD=1 adds the benchmark; training, R7, R8: tests/README.md)
	tests/validate/run-all.sh

leftovers: ## Residue report after destroying one stack (read-only, never fails): $(STACK)'s labelled resources + CSI disks and GPU clusters
	scripts/leftovers.sh --stack $(STACK)

leftovers-stage: ## Gate when retiring a whole stage (read-only): fails if ANYTHING is left in the stage's project
	scripts/leftovers.sh --stage $(STAGE) --expect-empty

quota-check: ## Project quota caps vs the tenant quota, and tenant zeros the stacks need (read-only; NEBIUS_PROFILE honoured)
	scripts/quota-plan.py

soperator-plan: ## Soperator for $(STAGE): fetch the recipe with the stage backend, init, save soperator-$(STAGE).tfplan (exported TF_VAR_slurm_login_ssh_root_public_keys passed as -var: the recipe's terraform.tfvars would win over it)
	scripts/fetch-soperator.sh --stage $(STAGE)
	cd $(SOPERATOR_DIR) && $(TERRAFORM_SOPERATOR) init -input=false -reconfigure && \
	  $(TERRAFORM_SOPERATOR) plan -input=false $(call SOPERATOR_VARS,$(STAGE)) $(if $(MR_URL),-var iam_merge_request_url=$(MR_URL)) \
	    $(if $(TF_VAR_slurm_login_ssh_root_public_keys),-var="slurm_login_ssh_root_public_keys=$${TF_VAR_slurm_login_ssh_root_public_keys}") -out=soperator-$(STAGE).tfplan

# The recipe labels nothing, so stage-policy never sees its TTL: where the stage has require_ttl_label
# (sandbox, lab) the apply is refused until make ttl-teardown STACK=soperator is running (scripts/ttl-armed.sh).
soperator-apply: ## Apply the saved Soperator plan through tf-run.sh (CONFIRM=yes required; a TTL-bound stage needs its ttl-teardown job armed first)
	@test "$(CONFIRM)" = "yes" || { echo "Refusing: set CONFIRM=yes after reviewing soperator-$(STAGE).tfplan (terraform/stacks/soperator/README.md)"; exit 1; }
	@scripts/ttl-armed.sh --stage $(STAGE) --stack soperator
	TERRAFORM=$(TERRAFORM_SOPERATOR) scripts/tf-run.sh $(SOPERATOR_DIR) soperator-$(STAGE).tfplan

# The recipe's destroy-time cleanup needs python3 >= 3.11, kubectl and the nebius CLI (runbooks/teardown.md);
# the same var files and -var keys as the plan, so the destroy plan sees the inputs the stage was applied with.
soperator-destroy-plan: ## Save a Soperator destroy plan for $(STAGE) (refused for STAGE=prod)
	@test "$(STAGE)" != "prod" || { echo "Refusing: prod is torn down through the release process, not make (runbooks/teardown.md)"; exit 1; }
	scripts/fetch-soperator.sh --stage $(STAGE)
	cd $(SOPERATOR_DIR) && $(TERRAFORM_SOPERATOR) init -input=false -reconfigure && \
	  $(TERRAFORM_SOPERATOR) plan -destroy -input=false $(call SOPERATOR_VARS,$(STAGE)) $(if $(MR_URL),-var iam_merge_request_url=$(MR_URL)) \
	    $(if $(TF_VAR_slurm_login_ssh_root_public_keys),-var="slurm_login_ssh_root_public_keys=$${TF_VAR_slurm_login_ssh_root_public_keys}") -out=soperator-$(STAGE)-destroy.tfplan

soperator-destroy: ## Apply the saved Soperator destroy plan through tf-run.sh (CONFIRM=yes required; refused for STAGE=prod)
	@test "$(STAGE)" != "prod" || { echo "Refusing: prod is torn down through the release process, not make (runbooks/teardown.md)"; exit 1; }
	@test "$(CONFIRM)" = "yes" || { echo "Refusing: set CONFIRM=yes after reviewing soperator-$(STAGE)-destroy.tfplan (runbooks/teardown.md)"; exit 1; }
	TERRAFORM=$(TERRAFORM_SOPERATOR) scripts/tf-run.sh $(SOPERATOR_DIR) soperator-$(STAGE)-destroy.tfplan

## --- Nebius Estate portal (local; read-only toward the cloud) -----------------
# Node.js 24 (22 also works) and a `yarn` on PATH (docs/portal/development.md). The portal never runs
# terraform and makes only read-only cloud calls; these targets build, test and serve it locally.
PORTAL_YARN := cd portal && yarn

portal-install: ## Install portal dependencies from the lockfile
	$(PORTAL_YARN) install --immutable

portal-dev: ## Portal dev servers on loopback against your account (load .env first: set -a; source .env; set +a)
	$(PORTAL_YARN) start

portal-demo: ## Synthetic estate on loopback, without cloud credentials or private configuration
	$(PORTAL_YARN) demo

doctor: ## Read-only prerequisite and demo port checks; never installs tools or calls the cloud
	node portal/scripts/doctor.mjs

portal-test: ## Portal unit + integration tests (all packages)
	$(PORTAL_YARN) test:all --ci

portal-e2e: ## Portal Playwright + axe tests against the loopback Nebius API stub (ports 3100/7107; no credentials)
	$(PORTAL_YARN) test:e2e

portal-verify-live: ## Probe every portal capability against your account (read-only; load .env first)
	cd portal && CI=1 yarn verify:live

portal-build: ## Typecheck, lint, config schema check and build the portal (app + backend)
	$(PORTAL_YARN) tsc
	$(PORTAL_YARN) lint:all
	$(PORTAL_YARN) config:check
	$(PORTAL_YARN) build:all
