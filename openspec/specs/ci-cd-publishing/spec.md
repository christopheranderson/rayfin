# CI/CD Publishing Specification

## Purpose

Define automated publishing workflows for Rayfin packages and containers, ensuring version alignment and efficient resource usage. This specification establishes the triggers, version detection logic, and tagging strategy for WebService container publishing synchronized with CLI version bumps.

## Requirements

### Requirement: WebService Container Publishing Trigger

The CI/CD system SHALL publish WebService containers only when the Rayfin CLI package version changes or manual override is requested.

**ID**: `CICD-WEBSERVICE-PUBLISH-001`

#### Scenario: CLI version bump triggers container publish

**Given** a contributor has merged a PR that bumps `@microsoft/rayfin-cli` version from 1.5.0 to 1.6.0
**And** the PR includes host package changes
**When** the commit is pushed to the main branch
**Then** the publish-webservice workflow SHALL trigger
**And** the workflow SHALL detect the CLI version change
**And** the workflow SHALL build and publish the WebService container
**And** the container SHALL be tagged with `latest`
**And** the container SHALL be tagged with `1.6.0`

#### Scenario: Host package change without CLI version bump

**Given** a contributor has merged a PR that modifies files in `packages/host/`
**But** the `@microsoft/rayfin-cli` version in `packages/tools/cli/package.json` is unchanged
**When** the commit is pushed to the main branch
**Then** the publish-webservice workflow MAY trigger for path detection
**But** the workflow SHALL skip the build and publish steps
**And** no new container SHALL be published to registries

#### Scenario: Manual container publish override

**Given** a WebService hotfix is needed urgently
**And** the CLI version has not changed
**When** a contributor triggers the workflow via workflow_dispatch
**And** sets the `force_publish` input to `true`
**Then** the workflow SHALL build and publish the WebService container
**And** the container SHALL be tagged with `latest`
**And** the container SHALL be tagged with the current CLI version
**And** the workflow SHALL proceed regardless of version change detection

### Requirement: Container Version Tagging

The CI/CD system SHALL tag WebService containers with both `latest` and the CLI version number.

**ID**: `CICD-WEBSERVICE-TAGGING-001`

#### Scenario: Dual-tagged container images

**Given** the CLI version is `1.6.0`
**When** the WebService container is published
**Then** the container SHALL be tagged with `latest`
**And** the container SHALL be tagged with `1.6.0`
**And** both tags SHALL be pushed to both GHCR and ACR registries

#### Scenario: Tag updates for hotfixes

**Given** a WebService container was previously published with CLI version `1.6.0`
**And** a hotfix is applied via manual workflow dispatch
**When** the container is republished
**Then** both the `latest` and `1.6.0` tags SHALL be updated to point to the new image
**And** the new image reflects the hotfix changes

### Requirement: Version Change Detection

The CI/CD system SHALL accurately detect CLI version changes by comparing package.json between commits.

**ID**: `CICD-VERSION-DETECTION-001`

#### Scenario: Version comparison between commits

**Given** the workflow is triggered on push to main
**When** the version detection step runs
**Then** the system SHALL checkout the repository with fetch-depth 2
**And** the system SHALL extract the version from `packages/tools/cli/package.json` at HEAD
**And** the system SHALL extract the version from `packages/tools/cli/package.json` at HEAD~1
**And** the system SHALL compare the two versions
**And** if versions differ, set output `should_publish=true` and `cli_version=<new-version>`
**And** if versions match, set output `should_publish=false`

#### Scenario: First commit in repository

**Given** the workflow is triggered on the first commit (no HEAD~1 exists)
**When** the version detection step runs
**Then** the system SHALL handle the missing parent commit gracefully
**And** the system SHALL default to `should_publish=true`
**And** the system SHALL use the current CLI version for tagging

### Requirement: Workflow Path Triggers

The CI/CD system SHALL monitor specific file paths to trigger workflow execution efficiently.

**ID**: `CICD-WORKFLOW-PATHS-001`

#### Scenario: Path-based workflow triggering

**Given** a contributor pushes changes to the main branch
**When** the changes include modifications to `packages/tools/cli/package.json`
**Then** the publish-webservice workflow SHALL be eligible to run
**And** the version detection SHALL determine if building proceeds

**When** the changes include modifications to `packages/host/**`
**Then** the publish-webservice workflow SHALL be eligible to run
**And** the version detection SHALL determine if building proceeds

**When** the changes include modifications to `.github/workflows/publish-webservice.yml`
**Then** the publish-webservice workflow SHALL run
**And** the version detection SHALL determine if building proceeds

**When** the changes do NOT include any of these paths
**Then** the publish-webservice workflow SHALL NOT trigger at all

### Requirement: Workflow Manual Dispatch

The CI/CD system SHALL provide manual workflow dispatch capability for emergency and testing scenarios.

**ID**: `CICD-MANUAL-DISPATCH-001`

#### Scenario: Manual workflow invocation

**Given** a contributor has permissions to run workflows
**When** they trigger the publish-webservice workflow via GitHub UI
**Then** the workflow SHALL present an option for `force_publish` (boolean, default false)
**And** if `force_publish` is true, the workflow SHALL bypass version change detection
**And** if `force_publish` is false, the workflow SHALL apply normal version detection logic

#### Scenario: Emergency hotfix publication

**Given** a critical WebService bug is discovered in production
**And** a fix is committed but CLI version was not bumped
**When** a contributor manually triggers the workflow with `force_publish=true`
**Then** the container SHALL be built and published immediately
**And** the container SHALL be tagged with `latest`
**And** the container SHALL be tagged with the current CLI version
**And** the workflow SHALL log that manual override was used
