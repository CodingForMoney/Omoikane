---
name: source-review
slug: source-review
description: Verify source artifacts and separate evidence from inference before concluding.
omoikane:
  schema_version: 1
  workspace: none
  requires:
    tools: []
    commands: []
    network: false
  entrypoints: {}
---

# Source review

When a task depends on supplied files or external evidence:

1. Inspect the source before forming a conclusion.
2. Distinguish directly supported facts from inferences.
3. When the Agent is configured with `artifact_create`, record material intermediate results as temporary Run artifacts.
4. Never copy credentials or authentication data into business context stores or artifacts.
