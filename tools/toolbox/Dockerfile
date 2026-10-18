# Pinned toolbox for every static check and operator command in this repository.
# Versions and sha256 sums come from platform/versions.yaml (tooling.*) through
# `scripts/pins.py build-args`; this file holds none, so it cannot drift.
#   make toolbox      build it (linux/amd64)
#   make ci-docker    run `make ci` inside it
ARG BASE_IMAGE
FROM --platform=linux/amd64 ${BASE_IMAGE}

ARG TERRAFORM_VERSION
ARG TERRAFORM_SHA256
ARG TERRAFORM_SOPERATOR_VERSION
ARG TERRAFORM_SOPERATOR_SHA256
ARG TFLINT_VERSION
ARG TFLINT_SHA256
ARG CONFTEST_VERSION
ARG CONFTEST_SHA256
ARG KUBECTL_VERSION
ARG KUBECTL_SHA256
ARG SHELLCHECK_VERSION
ARG SHELLCHECK_SHA256
ARG TRIVY_VERSION
ARG TRIVY_SHA256
ARG GITLEAKS_VERSION
ARG GITLEAKS_SHA256
ARG JQ_VERSION
ARG JQ_SHA256
ARG LYCHEE_VERSION
ARG LYCHEE_SHA256
ARG NEBIUS_CLI_VERSION
ARG NEBIUS_CLI_SHA256

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# OS packages come from the base image's Debian suite (pinned by digest).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git make unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# fetch <url> <sha256> <file>: download and verify, or fail the build.
RUN printf '#!/bin/bash\nset -euo pipefail\ncurl -fsSL --retry 3 -o "$3" "$1"\necho "$2  $3" | sha256sum -c -\n' > /usr/local/bin/fetch \
 && chmod +x /usr/local/bin/fetch

WORKDIR /tmp/tools
RUN fetch "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" "${TERRAFORM_SHA256}" tf.zip \
 && unzip -q tf.zip terraform -d /usr/local/bin && rm tf.zip \
 && fetch "https://releases.hashicorp.com/terraform/${TERRAFORM_SOPERATOR_VERSION}/terraform_${TERRAFORM_SOPERATOR_VERSION}_linux_amd64.zip" "${TERRAFORM_SOPERATOR_SHA256}" tf.zip \
 && unzip -q tf.zip terraform -d /tmp/tools/tf2 && mv /tmp/tools/tf2/terraform /usr/local/bin/terraform-soperator && rm -r tf.zip tf2 \
 && fetch "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_linux_amd64.zip" "${TFLINT_SHA256}" tflint.zip \
 && unzip -q tflint.zip tflint -d /usr/local/bin && rm tflint.zip \
 && fetch "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz" "${CONFTEST_SHA256}" c.tgz \
 && tar -xzf c.tgz -C /usr/local/bin conftest && rm c.tgz \
 && fetch "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" "${KUBECTL_SHA256}" /usr/local/bin/kubectl \
 && chmod +x /usr/local/bin/kubectl \
 && fetch "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" "${SHELLCHECK_SHA256}" sc.txz \
 && tar -xJf sc.txz --strip-components=1 -C /usr/local/bin "shellcheck-v${SHELLCHECK_VERSION}/shellcheck" && rm sc.txz \
 && fetch "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" "${TRIVY_SHA256}" t.tgz \
 && tar -xzf t.tgz -C /usr/local/bin trivy && rm t.tgz \
 && fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" "${GITLEAKS_SHA256}" g.tgz \
 && tar -xzf g.tgz -C /usr/local/bin gitleaks && rm g.tgz \
 && fetch "https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}/jq-linux-amd64" "${JQ_SHA256}" /usr/local/bin/jq \
 && chmod +x /usr/local/bin/jq \
 && fetch "https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/lychee-x86_64-unknown-linux-gnu.tar.gz" "${LYCHEE_SHA256}" l.tgz \
 && tar -xzf l.tgz --strip-components=1 -C /usr/local/bin lychee-x86_64-unknown-linux-gnu/lychee && rm l.tgz \
 && fetch "https://artifacts.nebius.cloud/cli/release/${NEBIUS_CLI_VERSION}/linux/x86_64/nebius" "${NEBIUS_CLI_SHA256}" /usr/local/bin/nebius \
 && chmod +x /usr/local/bin/nebius

# Runs as the invoking user (make passes --user); HOME and the provider cache are writable volumes.
ENV HOME=/tmp/home TF_PLUGIN_CACHE_DIR=/cache/terraform TF_IN_AUTOMATION=1 TERRAFORM_SOPERATOR=terraform-soperator
RUN mkdir -p /tmp/home /cache/terraform && chmod 1777 /tmp/home /cache /cache/terraform
USER 65532:65532
WORKDIR /repo
