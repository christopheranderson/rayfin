---
name: hotfix-release
description: >-
  Create a hotfix release branch, cherry-pick commits, bump the version, and
  open a draft PR. Use when: hotfix, patch release, cherry-pick to release,
  hotfix nuget, hotfix npm, release branch fix, backport fix.
license: MIT
metadata:
  author: rayfin
  version: "1.0"
---

Create a hotfix release for a previously published NuGet or npm package.

**Input**: The user provides:

- **Package type**: `nuget` or `npm`
- **Version to patch**: The published version to hotfix (e.g., `0.0.45` for NuGet, `1.31.0` for npm)
- **Commits to cherry-pick**: One or more commit SHAs, PR numbers, or branch names containing the fix

If any input is missing, use the **AskUserQuestion tool** to collect it:

- If package type is unclear, ask: `nuget` or `npm`?
- If version is missing, list recent tags with `git tag -l "nuget/v*" --sort=-version:refname | head -10` (or `npm/v*`) and let the user pick
- If commits are missing, ask for the commit SHAs or PR numbers to cherry-pick

## Steps

### 1. Validate the tag exists

```bash
git fetch origin --tags
git rev-parse "{{type}}/v{{version}}" >/dev/null 2>&1
```

If the tag doesn't exist, stop and tell the user. List available tags for that package type to help them.

### 2. Determine the hotfix version

**NuGet**: Use 4-part versioning. Check for existing hotfix tags:

```bash
git tag -l "nuget/v{{version}}.*" --sort=-version:refname
```

- If no prior hotfix: new version is `{{version}}.1`
- If `{{version}}.N` exists: new version is `{{version}}.N+1`

**npm**: Use semver patch bump. Parse the version parts and increment patch:

- `1.31.0` → `1.31.1`
- If `npm/v1.31.1` exists, use `1.31.2`, etc.

Announce the computed hotfix version to the user before proceeding.

### 3. Create the release branch

```bash
git checkout -b release/{{type}}-v{{version}} {{type}}/v{{version}}
git push origin release/{{type}}-v{{version}}
```

### 4. Create the fix branch and cherry-pick

```bash
git checkout -b fix/hotfix-{{type}}-v{{hotfix_version}} release/{{type}}-v{{version}}
```

Cherry-pick each provided commit:

```bash
git cherry-pick {{commit_sha}}
```

If a cherry-pick conflicts:

1. Show the conflicting files to the user
2. Ask them to resolve
3. After resolution, run `git cherry-pick --continue`

### 5. Bump the version

**NuGet**: Edit `packages/host/Version.props` — set `<VersionPrefix>` to the hotfix version:

```xml
<VersionPrefix>{{hotfix_version}}</VersionPrefix>
```

**npm**: Edit `packages/typescript-sdk/core/package.json` and any other affected packages — set `"version"` to the hotfix version. Rush version policies apply to all packages in the `typescript-sdk` policy, so update each affected package.

### 6. Commit the version bump

```bash
git add -A
git commit -m "chore(host): bump {{type}} version to {{hotfix_version}} for hotfix" --no-verify
```

### 7. Push and create a draft PR

```bash
git push origin fix/hotfix-{{type}}-v{{hotfix_version}}
```

Create a **draft PR** targeting `release/{{type}}-v{{version}}` (not `main`):

- **Title**: `fix({{type}}): hotfix v{{hotfix_version}}`
- **Body**: List the cherry-picked commits and the version bump
- **Draft**: true

### 8. Summary

After creating the PR, print a summary:

```
✅ Hotfix prepared

  Package type:    {{type}}
  Base version:    {{version}}
  Hotfix version:  {{hotfix_version}}
  Release branch:  release/{{type}}-v{{version}}
  Fix branch:      fix/hotfix-{{type}}-v{{hotfix_version}}
  PR:              {{pr_url}}

Next steps:
  1. Review and merge the PR
  2. Queue the rayfin.official pipeline on release/{{type}}-v{{version}}
     - Set Publish{{Type}}: true
  3. Pipeline will publish and tag {{type}}/v{{hotfix_version}}
```

## Error Handling

- **Tag not found**: List available tags and ask the user to pick the correct version
- **Cherry-pick conflict**: Show conflicting files, let the user resolve, then continue
- **Branch already exists**: Ask the user if they want to use the existing branch or create a new one
- **Version already tagged**: Increment to the next available revision and confirm with the user
