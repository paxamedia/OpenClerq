---
name: 'Example'
slug: 'example'
version: '2026.1'
triggers: ['example', 'help']
description: 'Minimal skill template. Copy this folder to create your own skill.'
tools_required: []
network_domains: []
filesystem_scope: []
---

# Example skill

Add your skill instructions here. The agent uses this content when the skill is selected by the router.

## Tools

Describe what tools this skill can call (e.g. fs.read, http.request) and how to use them.

The three lists above say what the instructions expect: `tools_required` (policy tool names, such as
`fs.read` or `group:fs`), `network_domains` (hosts, such as `api.example.com`) and `filesystem_scope`
(paths, such as `docs/` or `~/Notes`). An empty list declares nothing. They are shown when you are asked
to trust a skill, and used only when you turn on enforcement. See docs/SKILLS.md.

## Output

Explain the expected output format and any constraints.
