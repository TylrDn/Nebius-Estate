# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/TylrDn/Nebius-Estate/security/advisories/new),
not in a public issue or pull request. Include what you found, where (file and line, or recipe ID), how to
reproduce it, and the impact you expect. You should get an acknowledgement within a week.

In scope: anything in this repository, for example a Terraform default that exposes a resource, a script
that leaks a credential, a workflow that could run untrusted code with secrets, or the portal reading or
writing more than it documents.
Bypasses or regressions in the maintained [local dependency patches](docs/security/dependency-backports.md)
are also in scope. Existing advisory risks and release decisions are recorded in the
[advisory review](docs/security/advisory-release-decision.md).

Out of scope: vulnerabilities in Nebius AI Cloud itself or in upstream projects (report those to Nebius or
the upstream maintainers), and findings that need credentials or access you were not given.

## If you find a secret or a real ID

This repository should contain no credentials, kubeconfigs, Terraform state, or real tenant, project or
resource IDs ([CONTRIBUTING](CONTRIBUTING.md), "No secrets, keys, kubeconfigs, state or real IDs"). If you
see one, report it privately as above so it can be revoked before it is removed from history.

## Supported versions

This is experimental source. Fixes are maintained on `main`; `v0.1.0` is a historical experimental snapshot.
Update from `main` for subsequent fixes; no release-branch backports are promised.
Known upstream advisories and their observed exposure are tracked in
[dependency security](docs/dependency-security.md); no production support is promised.
