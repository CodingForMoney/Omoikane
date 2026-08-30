import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "../src/container.js";
import { getSettings } from "../src/config.js";

if (!process.env.MIMO_API_KEY)
  throw new Error(
    "MIMO_API_KEY is required; put it in the ignored .env file or process environment",
  );

const root = await mkdtemp(join(tmpdir(), "omoikane-mimo-audio-e2e-"));
const container = await Container.create(
  getSettings({
    ...process.env,
    AGENT_DATABASE_URL: "pglite://:memory:",
    AGENT_ARTIFACT_ROOT: join(root, "artifacts"),
    AGENT_SKILL_ROOT: join(root, "skills"),
    AGENT_SANDBOX_ROOT: join(root, "sandboxes"),
    AGENT_CREDENTIAL_SECRET: "mimo-audio-e2e-ephemeral-secret",
    AGENT_TRACING_DISABLED: "true",
    OMOIKANE_LOG_LEVEL: "silent",
  }),
  { startWorker: false },
);

try {
  const connection = await container.providers.create({
    name: "MiMo Audio E2E",
    provider: "xiaomi_mimo",
    endpoint_profile: "token_plan_cn",
    api_key_env: "MIMO_API_KEY",
  });
  const validation = await container.providers.validate(connection.id);
  if (!validation.valid)
    throw new Error(`MiMo validation failed: ${String(validation.error)}`);

  const speech = await container.providers.synthesizeSpeech(connection.id, {
    model: "mimo-v2.5-tts",
    input: "这是 Omoikane 语音往返测试。",
    voice: "mimo_default",
    format: "wav",
    instructions: "使用清晰、自然的普通话朗读。",
  });
  const audioBytes = Buffer.from(speech.audio.data, "base64");
  if (audioBytes.length < 44 || audioBytes.subarray(0, 4).toString() !== "RIFF")
    throw new Error("MiMo TTS did not return a valid WAV payload");

  const transcription = await container.providers.transcribeAudio(
    connection.id,
    {
      model: "mimo-v2.5-asr",
      audio: { data: speech.audio.data, format: "wav" },
      language: "zh",
    },
  );
  if (!transcription.text.trim())
    throw new Error("MiMo ASR returned an empty transcript");

  process.stdout.write(
    `${JSON.stringify(
      {
        provider_valid: true,
        tts_model: speech.model,
        audio_format: speech.audio.format,
        audio_bytes: audioBytes.length,
        asr_model: transcription.model,
        transcript: transcription.text,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await container.close();
  await rm(root, { recursive: true, force: true });
}
