# Server settings verification

- [x] Work in `/data/workspace/.worktrees/opencode-server/superpowers-settings`.
- [x] Replace Orchestra defaults with immutable-pinned Superpowers v7.0.0.
- [x] Merge missing local instructions into the persistent global AGENTS.md and image defaults.
- [x] Verify schema (5 tests), shell checks, and real V2 2.0.26 plugin/skill loading.
- [x] Verify the running server delivers global instruction changes; defer global plugin activation by user request.
- [x] Document proposed additional V2 plugins without installing them.
- [x] Upgrade available npm, runtime image, and GitHub Action dependencies; no outdated direct npm dependencies remain.
- [x] Commit verified changes and open draft PR #16.
- [x] Obtain independent review: no critical or important findings; tests independently passed.
- [ ] Pass Docker build/smoke CI on amd64 and arm64 before merge.

## Follow-up test coverage

Registration tests do not exercise assembled model requests. Consider a deterministic
mock-provider fixture for global instruction delivery/ambient updates and Superpowers
bootstrap presence in top-level sessions versus absence in child sessions. Current
global delivery was verified by the running harness's instruction-update event.
