# OpenCode Instructions

## Worktrees

- Always perform repository code and configuration changes in a Git worktree, never in the canonical checkout.
- Use the shared workspace-root directory `/data/workspace/.worktrees/<repository>/<task>`; do not create repository-local `.worktrees` folders.
- Before editing, inspect the canonical checkout and create a task branch with `git worktree add`. Move the OpenCode session to the worktree and run edits, tests, commits, and pushes there.
- Keep uncommitted user changes untouched. Do not delete worktrees with uncommitted work or remove another session's worktree.
- For research-only tasks, reading the canonical checkout is fine. For non-Git directories, ask before initializing a repository.

## Workflow

- Use Superpowers skills through the native `skill` tool for planning, test-driven development, debugging, verification, and review when applicable. Use native `subagent` tools when those skills call for delegation; do not use Orchestra.
- The shared worktree location above overrides a skill's default worktree location. Preserve the Git and pull request rules below when following skills.
- Execute well-specified work directly. Reserve subagents for genuinely parallel or exploratory work, and tell each one to commit and push as it goes and to keep scratch files outside the repository.
- Once the user has made a decision, act on it. Do not reopen it or add verification loops they did not ask for.
- Stop everything you started (dev servers, containers, background processes, temp files) before finishing.

## Scope

- A narrowly scoped request defines the diff. Mention adjacent improvements in chat instead of committing them.
- When something broken turns up mid-task, fix it in a PR rather than filing a ticket for it.
- Never delete or weaken tests to make CI green. Ask first.
- Do not build machinery for edge cases a bot reviewer raises unless the user wanted that capability. Say it is out of scope.
- Prefer adding a function over changing an existing function's signature.
- When a producer omits a value the contract requires, fix the producer instead of loosening the contract.
- Do not ship dependency overrides (`pnpm.overrides`, `resolutions`, patches, vendoring) as a workaround. Find the upstream fix or report that the upgrade is blocked.
- If the user said "don't commit" or "edits only", that holds for follow-up changes until they say otherwise.
- Work in a named repository ends when its change is merged and its CI is green. Do not fan out into downstream repositories unasked.

## Verification

- Run a command that reads the state before claiming it: PR merged, file tracked, field present, deploy live. An empty result means "cannot see", not "does not exist".
- If an error or pending run would confirm the work, go and look. Do not end with an offer to check.
- Validate approaches that touch external systems against current primary docs, not memory, and cite the URLs.
- Prefer CI for full test suites: push and read the checks. Run locally only to iterate on one failing test or lint error, and never quote a local pass once CI has run.
- When a repository ships a production-like local setup (Docker, Compose, a run script), test with it rather than a quick substitute.
- Pin third-party GitHub Actions by commit SHA after checking `gh api repos/<owner>/<repo>/releases/latest`.
- When changing CI, trace which tool reads which variable. A secret existing in the repository does not mean the failing step uses it.

## Git Rules

- **NEVER force-push** (`git push --force`, `git push -f`, `--force-with-lease`, etc.) under any circumstances.
- Never amend or rebase a commit that has been pushed. Make follow-up commits.
- **Incremental commits:** Commit changes incrementally and granularly with clear, descriptive commit messages matching conventional commit conventions. When importing existing or untracked state into a repository, commit the baseline state first before making improvements so the user can review the diff.
- Stage explicit paths. Never `git add -A` or `git add .` while another agent or process shares the checkout.
- Gate every commit and push on the branch name, for example `[ "$(git branch --show-current)" = "<branch>" ] && git commit ...`, then confirm the push with `git rev-parse HEAD origin/<branch>`.
- The user pushes commits to open PR branches. Fetch before pushing. If a push is rejected, pull (a merge commit is fine) and push again.
- Use one branch per task, even across phases. Branch independent PRs off `main` instead of stacking them.
- Pass `--repo owner/name` to `gh pr` commands instead of relying on the working directory.
- Never run `gh pr merge --auto` on `icco` repositories. They have no branch protection, so it merges immediately without waiting for CI.
- After a squash merge, confirm late commits landed with `git merge-base --is-ancestor <sha> origin/main`, and re-land anything missing in a small follow-up PR.
- Commits under the user's account are often an earlier agent's work. Do not cite authorship metadata as evidence of who designed something.

## Programming languages

- TypeScript, Shell, and Go are the only permitted programming languages in the user's repositories without explicit user approval. Do not introduce Python code, dependencies, or artifacts. Existing declarative configuration and third-party services are not permission to add another programming language.

## Code

- Default to no comments. Add one line for a non-obvious why, two only when the second adds a real constraint. Rationale belongs in the commit message.
- Never restate the code, narrate history, or put ticket IDs or current infrastructure state in comments.
- Config files (YAML, Dockerfiles, workflows) get no explanatory comments.
- Every exported Go identifier gets exactly one doc comment that starts with its name.
- Never swallow errors. Return, log, or show every one, and in retry loops surface the last error on timeout.
- Prefer the standard library and well-known packages over hand-rolled utilities.
- Use clearly fictional names (Ada Lovelace, alice, bob) in tests, fixtures, and docs, never real people.
- Use `Taskfile.yml` (go-task v3) for build automation in personal projects, not Makefiles.
- Edit YAML with `yq` and format it with `yq -iP .`, since plain `-i` corrupts folded block scalars. Put YAML comments on their own line.
- Pipe JSON with `printf '%s' "$json"`, never `echo`, which expands `\n` in zsh.
- In `icco` Go repositories use `go.icco.me/gutil` for logging, JSON responses, and ETags, chi for routing, and GORM with `AutoMigrate` for Postgres. Load the `icco-go-repo` skill for repository plumbing.
- `golangci-lint` caps output at 50 issues per linter. Pass `--max-issues-per-linter=0 --max-same-issues=0` for true counts.
- Measure Go coverage with the toolchain from `go.mod` (`GOTOOLCHAIN=go1.x.y`), since totals differ between Go versions.
- Regenerate lock files with their tool (`tofu init -upgrade`, `pnpm install`). Never hand-edit them.
- In Terraform, module constants go in `locals.tf`, not in variables with defaults.

## Writing

- Brevity matters most. Cut every sentence that does no work, and cut before publishing, not after.
- ASCII only. No em dashes.
- Never hard-wrap Markdown or prompts. One paragraph or bullet per line.
- Link to sources instead of paraphrasing them.
- READMEs lead with install and usage. Check every factual claim in docs against what was measured.
- Return requested documents in the reply, not in a new file, unless the user names a path.
- When the work depends on something unknown, look it up, then ask the user directly before continuing. Never bury a decision in a trailing caveat or a PR body.

## Pull request workflow

- Open draft pull requests early, then commit and push small, verified changes frequently instead of waiting for the whole task to finish.
- Open a pull request by default for repository code or configuration changes after verification passes; do not stop at uncommitted local edits unless the user explicitly asks otherwise.
- Load the `commit-push-pr` skill when committing, pushing, or opening a pull request.

## Pull request descriptions

- Before creating or editing a PR, read and follow its repository's PR template. Check the repository owner's `.github` repository for an inherited template when there is no repository-local template. Never assume no local file means no template exists.
- For `icco` repositories, the inherited template is `https://github.com/icco/.github/blob/main/pull_request_template.md`. Fetch the current template rather than relying only on this remembered copy.
- The current template uses exactly `# Why` and `# Risks`. Keep both sections concise. Do not replace them with Summary, Validation, Test Plan, Deployment, or other assistant-generated sections. Put essential rollout caveats under Risks; leave detailed setup instructions in repository documentation.
- Keep bodies to six lines of content or fewer, excluding template headers. Write for the reviewer: no narrative of the work, no bugs found along the way, no test-plan checklist.
- Never add AI attribution to a PR body. `Co-Authored-By` trailers in commits are fine.
- Use Conventional Commit PR titles with lowercase subjects. PRs are squash-merged.
- Pick the type honestly: `fix` for repairs, `chore`, `docs`, `ci`, or `build` for plumbing, and `feat` only for a new user-facing capability. Avoid `refactor`. The title drives semantic-version bumps.

## Personal infrastructure

- Merged changes reach the `mist` host through its hourly cron at :24. Do not deploy by hand. Wait, then check the container's start time and logs.
- `*.natwelch.com` sites follow resume.natwelch.com: Avenir Next, 16px/1.5 body, 32px weight-400 h1, `#265c83` links, one column about 800px wide.
