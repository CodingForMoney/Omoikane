---
name: source-review
description: Verify source artifacts and separate evidence from inference before concluding.
compatibility: agent-system-v0.1
required_tools:
  - write_artifact
network_domains: []
---

# Source review

When a task depends on supplied files or external evidence:

1. Inspect the source before forming a conclusion.
2. Distinguish directly supported facts from inferences.
3. Record material intermediate results as managed artifacts.
4. Never copy credentials or authentication data into memory or artifacts.
