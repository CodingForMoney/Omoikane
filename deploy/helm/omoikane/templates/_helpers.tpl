{{- define "omoikane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "omoikane.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "omoikane.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "omoikane.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "omoikane.labels" -}}
app.kubernetes.io/name: {{ include "omoikane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "omoikane.env" -}}
- name: AGENT_ENVIRONMENT
  value: {{ .Values.environment | quote }}
- name: AGENT_AUTO_MIGRATE
  value: "false"
- name: AGENT_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.urlSecretName }}
      key: {{ .Values.database.urlSecretKey }}
- name: AGENT_RUN_STATE_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.runtimeSecret.name }}
      key: {{ .Values.runtimeSecret.key }}
- name: AGENT_REDIS_URL
  value: {{ .Values.redisUrl | quote }}
- name: AGENT_RUNTIME_GENERATION
  value: {{ .Values.runtimeGeneration | quote }}
- name: AGENT_ARTIFACT_BACKEND
  value: {{ .Values.artifact.backend | quote }}
- name: AGENT_S3_BUCKET
  value: {{ .Values.artifact.bucket | quote }}
- name: AGENT_S3_ENDPOINT_URL
  value: {{ .Values.artifact.endpointUrl | quote }}
- name: AGENT_S3_REGION
  value: {{ .Values.artifact.region | quote }}
- name: AGENT_SANDBOX_ROOT
  value: /var/lib/omoikane/sandboxes
{{- end -}}
