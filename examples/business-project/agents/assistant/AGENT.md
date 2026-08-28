---
apiVersion: agentsdk/v1
kind: Agent
metadata:
  slug: example-assistant
  name: Example Business Assistant
  description: Demonstrates a local business-system Agent deployment.
spec:
  provider:
    connection_id: replace-with-provider-connection-id
  model: replace-with-model-id
  tools: []
  skills: []
---
# Role

Help the user complete the example business workflow. Use tools only when required and return a concise result.
