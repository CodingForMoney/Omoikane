import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/api.js";
import { OmoikaneClient } from "../src/client/index.js";
import type { Container } from "../src/container.js";
import { testContainer } from "./helpers.js";

let app: FastifyInstance | undefined;
let container: Container | undefined;
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await app?.close();
  await cleanup?.();
  app = undefined;
  container = undefined;
  cleanup = undefined;
  vi.unstubAllGlobals();
});

async function setup() {
  const test = await testContainer();
  container = test.container;
  cleanup = test.close;
  const connection = await container.providers.create({
    name: "MiMo Audio",
    provider: "xiaomi_mimo",
    api_key: "test-only-audio-key",
  });
  app = await createApp(container);
  return { app, connection };
}

describe("dedicated audio API", () => {
  it("exposes MiMo transcription and speech through validated REST routes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "你好" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { audio: { data: "UklGRg==" } } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const { app, connection } = await setup();

    const transcription = await app.inject({
      method: "POST",
      url: `/v1/provider-connections/${connection.id}/audio/transcriptions`,
      payload: {
        audio: { data: "UklGRg==", format: "wav" },
        language: "zh",
      },
    });
    expect(transcription.statusCode).toBe(200);
    expect(transcription.json()).toEqual({
      model: "mimo-v2.5-asr",
      text: "你好",
    });

    const speech = await app.inject({
      method: "POST",
      url: `/v1/provider-connections/${connection.id}/audio/speech`,
      payload: { input: "你好", voice: "mimo_default", format: "wav" },
    });
    expect(speech.statusCode).toBe(200);
    expect(speech.json()).toEqual({
      model: "mimo-v2.5-tts",
      audio: {
        data: "UklGRg==",
        format: "wav",
        mime_type: "audio/wav",
      },
    });

    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
    });
    expect(capabilities.json().features).toMatchObject({
      audio_transcription: true,
      speech_synthesis: true,
    });
  });

  it("rejects malformed audio before invoking a Provider", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { app, connection } = await setup();
    const response = await app.inject({
      method: "POST",
      url: `/v1/provider-connections/${connection.id}/audio/transcriptions`,
      payload: {
        audio: { data: "not-base64", format: "wav" },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: "invalid_request",
      message: "request validation failed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("provides typed npm client methods for both routes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ model: "mimo-v2.5-asr", text: "client ASR" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "mimo-v2.5-tts",
            audio: {
              data: "UklGRg==",
              format: "wav",
              mime_type: "audio/wav",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new OmoikaneClient({
      baseUrl: "http://127.0.0.1:8000",
      fetch: fetcher,
    });

    await client.transcribeAudio("provider-id", {
      model: "mimo-v2.5-asr",
      audio: { data: "UklGRg==", format: "wav" },
      language: "auto",
    });
    await client.createSpeech("provider-id", {
      model: "mimo-v2.5-tts",
      input: "client TTS",
      format: "wav",
    });

    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:8000/v1/provider-connections/provider-id/audio/transcriptions",
    );
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:8000/v1/provider-connections/provider-id/audio/speech",
    );
  });
});
