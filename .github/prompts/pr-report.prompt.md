---
agent: agent
description: This prompt is used to generate a Rayfin engineering progress report based on PR data collected from GitHub.
---

**Repository:** `microsoft/project-rayfin` (hardcoded)

**Inputs:**
- Date range can be specified either:
  - **Explicit dates**: `since:YYYY-MM-DD until:YYYY-MM-DD`
  - **Relative period**: `last N days`, `last N weeks`, `last N months`
  - **Default**: If not specified, use last 60 days

**Example usage:**
```
@workspace /rayfin-report since:2025-10-22 until:2025-12-22
@workspace /rayfin-report last 60 days
@workspace /rayfin-report last 2 months
```

---

## Instructions for Agent

You are an AI assistant. Your job is to:
1. Extract input parameters from the user's request
2. Collect authoritative PR evidence for the reporting window
3. Generate a leadership-ready Markdown report with charts and insights

### Input Parameters

Parse these from the user's request. Support both explicit dates and relative periods:

#### Date Range (flexible formats)

**Option 1: Explicit dates**
- **`since`**: Start date (format: `YYYY-MM-DD`)
- **`until`**: End date (format: `YYYY-MM-DD`, default: today)
- Example: `since:2025-10-22 until:2025-12-22`

**Option 2: Relative period**
- Parse phrases like: `last N days`, `last N weeks`, `last N months`, `past N days`, etc.
- Calculate `since` = today - N (days/weeks/months), `until` = today
- Examples:
  - `last 60 days` → since: 60 days ago, until: today
  - `last 2 months` → since: 2 months ago, until: today
  - `past 1 month` → since: 1 month ago, until: today

**Default:** If no date range specified, use last 60 days

#### Other Parameters

- **`limit`** (optional): Maximum PRs to collect (for testing only)
  - Example: `30`
  - Default: no limit (collect all PRs in window)
  - **Note:** Final production reports should NOT use a limit

**Repository:** `microsoft/project-rayfin` (always used)

### Reporting Context

- **Audience:** Engineering leadership, managers, partner leads
- **Goal:** Demonstrate concrete progress and momentum using verifiable PR evidence
- **Tone:** Crisp, outcome-focused, not overly technical; include references (PR numbers/URLs) for credibility

### Definitions (MUST follow)

- **Reporting window:** `{since}..{until}` (inclusive per `mergedAt`)
- **"PR merged":** PR in the window with `mergedAt` populated
- **"OpenSpec-related PR":** Any PR where any changed file path starts with `openspec/specs/`
- **"Copilot co-authored PR":** Any PR where the author is `copilot-swe-agent`
- **"PR category":** Determined by keyword matching on PR title (e.g., "auth", "postgres", "e2e", "sample", etc.)

### Hard Rules

- Use only the information in the generated `.temp/rayfin-data-{since}-to-{until}.json` file. Do not guess features not supported by PR titles, paths, labels, or commit messages
- When making claims about "major features", cite at least 1–3 PRs (number + URL) per theme
- If any numbers are incomplete due to collection limit, state it clearly
- Prefer charts when it helps show trends; prefer tables for "top PRs" and "metrics summary"

---

## Agent Runbook (execute these steps)

### Step 0 — Prerequisites Check

Confirm in terminal:
```bash
gh --version
gh auth status
node --version
```

Verify:
- GitHub CLI installed and authenticated
- Node.js v18+ available
- Current directory is `docs/reporting`

### Step 1 — Collect PR Evidence

Run the collector script with the user-provided parameters:

```bash
cd docs/reporting
npx tsx scripts/collect.ts --repo microsoft/project-rayfin --since {since} --until {until}
```

This will generate `.temp/rayfin-data-{since}-to-{until}.json` (e.g., `.temp/rayfin-data-2025-10-22-to-2025-12-22.json`).

**For testing iterations**, you may temporarily use:
```bash
npx tsx scripts/collect.ts --repo microsoft/project-rayfin --since {since} --until {until} --limit 30
```

**Important:** The final production report MUST be generated without `--limit`.

### Step 2 — Validate Evidence

Open and inspect `.temp/rayfin-data-{since}-to-{until}.json`:
- Confirm `search.issueCount` is present
- Confirm `pullRequests` array is non-empty
- Confirm each PR has flags: `openspec`, `copilotCoauthored`

Print a quick summary:
```
Collected PRs: {count}
OpenSpec PRs: {openspecCount}
Copilot co-authored PRs: {copilotCount}
Contributors: {uniqueAuthors}
```

### Step 3 — Generate Report

Run the report generator:
```bash
npx tsx scripts/generate_report.ts .temp/rayfin-data-{since}-to-{until}.json
```

This will read the data file and generate `rayfin-report-{since}-to-{until}.md`.

**Example:**
```bash
npx tsx scripts/generate_report.ts .temp/rayfin-data-2025-10-22-to-2025-12-22.json
# Generates: rayfin-report-2025-10-22-to-2025-12-22.md
```

---

## Report Structure (Template Reference)

The generated report follows this structure. See `generate_report.ts` for implementation details.

### Title & Metadata

```markdown
# Rayfin Progress Report (Last 2 Months)

**Repository:** `microsoft/project-rayfin`
**Reporting Window:** {since} → {until}
**Generated:** {today's date}
```

### 1) Executive Summary

5-8 bullets focusing on:
- Execution momentum (PR count, contributors, velocity)
- AI adoption (Copilot co-authored PRs)
- Spec-first development (OpenSpec PRs)
- Security & authentication improvements
- Data API platform expansion
- Engineering excellence investments
- Adoption enablement (samples, docs)

### 2) Metrics Dashboard

Table with key metrics:
- Total merged PRs
- Copilot co-authored PRs (count and %)
- OpenSpec PRs (count and %)
- Unique contributors
- Average files changed per PR
- Average churn (additions + deletions)

### 3) Delivery Trends & Adoption

Mermaid charts:
- **Weekly PRs**: Bar chart showing PRs merged per week
- **Category Distribution**: Pie chart of PR categories
- **Copilot Adoption**: Pie chart of co-authored vs standard PRs

### 4) Major Themes & Features Delivered

4-6 themes, each with:
- Theme name (e.g., "Auth & Security")
- 2-5 feature bullets
- PR citations (at least 2 per theme)

### 5) AI + OpenSpec Insights

Narrative section with:
- Counts and implications
- 3-8 example PRs for OpenSpec
- 3-8 example PRs for Copilot co-authored

### 6) Risks / Follow-ups

3-6 bullets derived from PR evidence (refactoring churn, CI/test work, security hardening)

### 7) Forward Commitments

Editable section for manual updates:
- Next 4-8 weeks goals (3-5 items)
- Success metrics (3-5 items)

### 8) Appendix

- GitHub query link for the window
- All PRs table (if reasonable size)

---

## Requirements

- **File location:** `rayfin-report-{since}-to-{until}.md` (in `docs/reporting/` directory)
- **Charts:** Use Mermaid (xychart-beta for bar charts, pie for proportions)
- **PR citations:** `[#{number}](https://github.com/microsoft/project-rayfin/pull/{number})`
- **Markdown linting:**
  - Table separators: `| --- |` not `|---|`
  - Wrap bare URLs: `<url>`
  - Escape non-link brackets: `\[KEYWORD\]`

---

## Example Invocations

**Relative dates (recommended):**
```
Follow instructions in pr-report.prompt.md for the last 2 months
Generate Rayfin progress report for the last 60 days
Generate Rayfin progress report for the past 8 weeks
```

**Explicit dates:**
```
Follow instructions in pr-report.prompt.md since:2025-10-22 until:2025-12-22
Generate Rayfin progress report from 2025-10-22 to 2025-12-22
```

**With testing limit:**
```
Follow instructions in pr-report.prompt.md for the last 60 days limit:30
```

**Default (no params - uses last 60 days):**
```
Follow instructions in pr-report.prompt.md
Generate Rayfin progress report
```
