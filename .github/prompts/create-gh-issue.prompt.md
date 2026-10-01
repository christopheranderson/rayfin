---
mode: 'agent'
description: 'Create a GitHub issue using structured workflow.'
tools: ['codebase', 'search', 'github']
---

Follow this workflow to create a GitHub issue:

1. **Understand the issue**: Analyze the problem or request
2. **Clarify if needed**: Ask specific questions about unclear requirements
3. **Analyze independently**: Research codebase/existing issues if context is missing
4. **Propose**: Present concise title and body for approval
5. **Create**: Use create_issue tool after approval

**IMPORTANT**: Always propose the title and body before creating the issue.

## Title Requirements:
- Succinct and specific
- Action-oriented when possible
- No unnecessary words

## Body Requirements:
- Essential information only
- Clear problem statement
- Omit: success criteria, benefits, preamble/postamble (unless specifically requested)
- Keep simple - avoid over-engineering

## Repository Information (always file issues in this repository):
- Organization: microsoft
- Repository: project-rayfin
