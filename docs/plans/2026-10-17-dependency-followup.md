# Dependency remediation follow-up

Keep PR #23 private, mark it ready for review, and preserve all required checks.
Never suppress advisory IDs, change audit coverage or fabricate patched versions.

1. Reconfirm the exact advisory graph and primary upstream release/patch evidence.
2. Upgrade compatible Octokit parents together; verify Backstage GitHub credentials,
   application JWTs, pagination and HTTP errors with local synthetic requests.
3. Remove sprintf-js through argparse 2's supported legacy API; exercise the real
   js-yaml 3 CLI and configuration parser.
4. Move UUID consumers to patched 11.1.1, adapting material-table's obsolete default
   import in a retained, attributed Yarn patch. Verify table behavior and UUID bounds.
5. Upgrade Router and DOM together to 7.18.4. Preserve named and wildcard Backstage
   route parameters with narrow attributed compatibility patches, and test the
   actual installed modern and legacy resolvers plus navigation security.
6. Generate the immutable lockfile and run compatibility/security regressions in
   pinned hosted containers. Then run the existing full checks unchanged.
7. Record exact passing checks and any remaining upstream blockers in the PR and
   dependency documentation. An unmerged source patch is not an official patched
   release or a clean registry audit. Leave unresolved findings visibly failing.

The local Docker daemon is unavailable. Repository installations and tests run in
the existing GitHub-hosted containers; host work is limited to edits, Git and
read-only source/registry inspection. No cloud operations, merge or publication.
