---
name: icco-go-repo
description: Conventions for creating or maintaining Go repositories under github.com/icco, covering scaffolding, lint configuration, CI workflows, versioning, and goreleaser releases. Use when creating a Go repository or changing its lint, CI, or release plumbing.
---

- Create repositories from the `icco/go-template` GitHub template. Do not copy `icco/reportd`, which is stale.
- Actions are disabled on the template itself. Confirm a new repository has them enabled with `gh api repos/icco/<repo>/actions/permissions`.
- Module paths are `go.icco.me/<repo>`. Libraries start at `v1.0.0`.
- Keep lint configuration in a committed `.golangci.yml`, never as `-E` flags in a workflow, so local runs and CI enforce the same set.
- If golangci-lint refuses to load because it was built with an older Go than `go.mod`, rebuild it with the current toolchain at CI's version (`go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@<version>`). Never skip lint because of it.
- `.yamllint` disables `document-start` and `line-length` and sets `truthy: check-keys: false`.
- The yaml-json auto-format step uses `file_pattern: '. :!.github/workflows/*'`. A literal `*.json` makes `git add` exit 128 in a repository without JSON.
- Releases use goreleaser, tagged by `PaulHatch/semantic-version`. Wrap `major_pattern` and `minor_pattern` in `/ /` so scoped titles such as `feat(api):` count.
- The PR title drives both the conventional-commits check and the version bump. Fix a bad title with `gh pr edit --title`.
- GitHub releases are immutable, so a failed goreleaser run cannot be retried for the same tag. Cut a new tag.
- `GET /repos/{owner}/{repo}` reports the user's permissions, not the token's. Probe a fine-grained PAT with a `PUT /contents/<existing file>` that sends an all-zero `sha`. A 403 means no write access, and a 409 means write access with nothing changed.
- READMEs show `go get`, a usage example, and a link to godoc. No Go Report Card badge.
