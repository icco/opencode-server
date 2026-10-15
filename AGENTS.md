# OpenCode Instructions

## Environment

- Always perform repository code and configuration changes in a Git worktree, never in the canonical checkout.
- Use the shared workspace-root directory `/data/workspace/.worktrees/<repository>/<task>`; do not create repository-local `.worktrees` folders. This location overrides a skill's default worktree location.
- Before editing, inspect the canonical checkout and create a task branch with `git worktree add`. Move the OpenCode session to the worktree and run edits, tests, commits, and pushes there.
- Keep uncommitted user changes untouched. Do not delete worktrees with uncommitted work or remove another session's worktree.
- For research-only tasks, reading the canonical checkout is fine. For non-Git directories, ask before initializing a repository.
- Never delete, move, or reset `/data/.config` or `/data/.local`. They hold the OpenCode database, logs, credentials, and OpenChamber settings for every session.
- Load skills with the native `skill` tool and delegate with native `subagent` tools; do not use Orchestra.

## Workflow

- Use Superpowers skills for planning, test-driven development, debugging, verification, and review when applicable. Preserve the Git and pull request rules below when following them.
- Execute well-specified work directly. Reserve subagents for genuinely parallel or exploratory work. Tell each one to commit and push as it goes, to keep scratch files outside the repository, and how short its comments and prose must be.
- Once the user has made a decision, act on it. Do not reopen it or add verification loops they did not ask for. "Automode" means keep executing the agreed plan without pausing for confirmation.
- For an obvious visible bug, go straight to the code and fix it. Skip git history forensics.
- When auditing noise (alerts, failing jobs), read and tally the actual signal (the inbox, the channel, the logs) before sweeping repositories.
- During an incident, do only the task the user named. Report blockers in one line.
- Stop everything you started (dev servers, containers, background processes, temp files) before finishing.

## Scope

- A narrowly scoped request defines the diff. Mention adjacent improvements in chat instead of committing them.
- When something broken turns up mid-task, fix it in a PR rather than filing a ticket for it. Add related work to the existing ticket instead of opening siblings.
- Never delete or weaken tests to make CI green. Ask first.
- Do not build machinery for edge cases a bot reviewer raises unless the user wanted that capability. Say it is out of scope.
- Prefer adding a function over changing an existing function's signature.
- When a producer omits a value the contract requires, fix the producer instead of loosening the contract.
- Do not ship dependency overrides (`pnpm.overrides`, `resolutions`, patches, vendoring) as a workaround. Find the upstream fix or report that the upgrade is blocked.
- If the user said "don't commit" or "edits only", that holds for follow-up changes until they say otherwise.
- Work in a named repository ends when its change is merged and its CI is green. Do not fan out into downstream repositories unasked.
- When the user names the fields a deliverable holds, include exactly those. Caveats and extra numbers go in chat.
- Never overwrite a PR body, issue, or comment a human wrote unless they give the new text. Comment instead.

## Verification

- Run a command that reads the state before claiming it: PR merged, file tracked, field present, deploy live. An empty result means "cannot see", not "does not exist".
- Derive inventories and load-bearing numbers from the code, citing `file:line`, not from tickets or earlier surveys.
- Before blaming the environment for a failure, check it and run a known-good control.
- If an error or pending run would confirm the work, go and look. Do not end with an offer to check.
- Validate approaches that touch external systems against current primary docs, not memory, and cite the URLs.
- Prefer CI for full test suites. Push and read the checks. Run locally only to iterate on one failing test or lint error, and never quote a local pass once CI has run.
- When CI regenerates docs (terraform-docs, gomarkdoc), do not run the generator locally.
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
- Use one branch per task, even across phases. Branch independent PRs off `main` instead of stacking them. Stack only when the user asks, with `gh stack`.
- Pass `--repo owner/name` to `gh pr` commands instead of relying on the working directory.
- Never run `gh pr merge --auto`. Without branch protection it merges immediately instead of waiting for CI.
- After a squash merge, confirm late commits landed with `git merge-base --is-ancestor <sha> origin/main`, and re-land anything missing in a small follow-up PR.
- Commits under the user's account are often an earlier agent's work. Do not cite authorship metadata as evidence of who designed something.
- Report git outcomes (pushed, PR link), not each step.

## Programming languages

- TypeScript, Shell, and Go are the only permitted programming languages in the user's personal repositories without explicit user approval. Do not introduce Python code, dependencies, or artifacts. Existing declarative configuration and third-party services are not permission to add another programming language.

## Code

- Default to no comments. Add one line for a non-obvious why, two only when the second adds a real constraint. Rationale belongs in the commit message.
- Never restate the code, narrate history, or put ticket IDs or current infrastructure state in comments.
- Config files (YAML, Dockerfiles, workflows) get no explanatory comments.
- Every exported Go identifier gets exactly one doc comment that starts with its name.
- Never swallow errors. Return, log, or show every one, and in retry loops surface the last error on timeout.
- Prefer the standard library and well-known packages over hand-rolled utilities.
- Judge approaches on substance. Import churn and lockfile size are not costs.
- Use clearly fictional names (Ada Lovelace, alice, bob) in tests, fixtures, and docs, never real people.
- Use `Taskfile.yml` (go-task v3) for build automation in personal projects, not Makefiles.
- Edit YAML with `yq` and format it with `yq -iP .`, since plain `-i` corrupts folded block scalars. Put YAML comments on their own line.
- Pipe JSON with `printf '%s' "$json"`, never `echo`, which expands `\n` in zsh.
- In Go repositories that depend on `gutil`, use it for logging, JSON responses, and ETags. Use chi for routing and GORM with `AutoMigrate` for Postgres. Load the `go-repo` skill for repository plumbing.
- `golangci-lint` caps output at 50 issues per linter. Pass `--max-issues-per-linter=0 --max-same-issues=0` for true counts.
- Measure Go coverage with the toolchain from `go.mod` (`GOTOOLCHAIN=go1.x.y`), since totals differ between Go versions.
- Regenerate lock files with their tool (`tofu init -upgrade`, `pnpm install`). Never hand-edit them, and never add re-resolving commands like `yarn upgrade` or `pnpm update` to CI.
- In Terraform, module constants go in `locals.tf`, not in variables with defaults. Pin modules as `~> X.Y.Z` and providers as `~> X.Y`.

## Writing

- Brevity matters most. Cut every sentence that does no work, and cut before publishing, not after.
- ASCII only. No em dashes.
- Never hard-wrap Markdown or prompts, even when the surrounding file is wrapped. One paragraph or bullet per line.
- Link to sources instead of paraphrasing them.
- READMEs lead with install and usage. Check every factual claim in docs against what was measured.
- Return requested documents in the reply, not in a new file, unless the user names a path.
- Status updates, reports, and research summaries get about ten short bullets, nested for detail, with no bold lead-ins and no Markdown tables. Put text meant for pasting in a fenced `markdown` block.
- When the work depends on something unknown, look it up, then ask the user directly before continuing, batching questions into one ask. Never bury a decision in a trailing caveat or a PR body.

## Pull request workflow

- Open draft pull requests early, then commit and push small changes frequently instead of waiting for the whole task to finish. Push unfinished work too, and note the WIP state in the commit message instead of holding the commit back.
- Open a pull request by default for repository code or configuration changes; do not stop at uncommitted local edits unless the user explicitly asks otherwise.
- Load the `commit-push-pr` skill when committing, pushing, or opening a pull request.

## Pull request descriptions

- Before creating or editing a PR, read and follow its repository's PR template. Check the repository owner's `.github` repository for an inherited template when there is no repository-local template. Never assume no local file means no template exists. With no template anywhere, write a short summary and a few bullets, with no section headers on a small PR.
- Use exactly the template's sections and keep each concise. Do not add Summary, Validation, Test Plan, Deployment, or other assistant-generated sections. Put essential rollout caveats under the risks section and leave detailed setup instructions in repository documentation.
- Check off a template's fixed checklist items; never add new ones. Write "No Risks Found" rather than dropping a risks section.
- Keep bodies to six lines of content or fewer, excluding template headers. Lead with one sentence on what the PR does, then what to look at, then risks and deferred work. Write for the reviewer: no narrative of the work, no bugs found along the way, no test-plan checklist.
- Keep detail in one place. If a README, doc, or the commit message already carries it, link to or skip it rather than repeating it.
- Never add AI attribution to a PR body. `Co-Authored-By` trailers in commits are fine.
- Use Conventional Commit PR titles with lowercase subjects. PRs are squash-merged.
- Pick the type honestly: `fix` for repairs, `chore`, `docs`, `ci`, or `build` for plumbing (`chore(deps)` for dependency upgrades), and `feat` only for a new user-facing capability. Avoid `refactor`. Mark breaking changes with `!` before the colon. The title drives semantic-version bumps.

## Personal sites

- `*.natwelch.com` sites follow resume.natwelch.com: Avenir Next, 16px/1.5 body, 32px weight-400 h1, `#265c83` links, one column about 800px wide.
