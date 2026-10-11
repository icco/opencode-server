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

## Git Rules

- **NEVER force-push** (`git push --force`, `git push -f`, `--force-with-lease`, etc.) under any circumstances.
- **Incremental commits:** Commit changes incrementally and granularly with clear, descriptive commit messages matching conventional commit conventions. When importing existing or untracked state into a repository, commit the baseline state first before making improvements so the user can review the diff.

## Programming languages

- TypeScript, Shell, and Go are the only permitted programming languages in the user's repositories without explicit user approval. Do not introduce Python code, dependencies, or artifacts. Existing declarative configuration and third-party services are not permission to add another programming language.

## Pull request workflow

- Open draft pull requests early, then commit and push small, verified changes frequently instead of waiting for the whole task to finish.
- Open a pull request by default for repository code or configuration changes after verification passes; do not stop at uncommitted local edits unless the user explicitly asks otherwise.

## Pull request descriptions

- Before creating or editing a PR, read and follow its repository's PR template. Check the repository owner's `.github` repository for an inherited template when there is no repository-local template. Never assume no local file means no template exists.
- For `icco` repositories, the inherited template is `https://github.com/icco/.github/blob/main/pull_request_template.md`. Fetch the current template rather than relying only on this remembered copy.
- The current template uses exactly `# Why` and `# Risks`. Keep both sections concise. Do not replace them with Summary, Validation, Test Plan, Deployment, or other assistant-generated sections. Put essential rollout caveats under Risks; leave detailed setup instructions in repository documentation.
- Use Conventional Commit PR titles with lowercase subjects. PRs are squash-merged.
