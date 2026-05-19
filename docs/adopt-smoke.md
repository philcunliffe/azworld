# Adopt-PR smoke

This file exists to exercise the `mol-adopt-pr` flow against a real PR.

A contributor (in this case, just a maintainer-author dry run) opens a PR
adding this single markdown file. The flow runs:

1. intake — parse the PR, fetch metadata, validate scope
2. rebase — sync against upstream main
3. review — run `mol-pr-dual-review` cross-pack
4. human-gate — block until a maintainer manually closes the gate bead
5. finalize — merge via one of paths A/B/C/D
6. complete — clean up refs and record final state

No code is touched. This is a docs-only PR by design.
