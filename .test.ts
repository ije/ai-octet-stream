import type { CompletionUsage } from "./index.ts";
import { describe, expect, it, mock } from "bun:test";
import { computeAICompletionCost, createAIStreamClient, createAIStreamServer } from "./index.ts";
import { STREAM_DONE, STREAM_END, STREAM_ERROR, STREAM_REASONING, STREAM_START, STREAM_TEXT, STREAM_TOOLCALL } from "./message-type.ts";
import { deserialize, serialize } from "./utils.ts";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("deserializeMessages", () => {
  it("parses frames across arbitrary chunk boundaries", async () => {
    const usage: CompletionUsage = {
      prompt_tokens: 12,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 2 },
    };
    const frames = [
      serialize(STREAM_START),
      serialize(STREAM_REASONING, "the"),
      serialize(STREAM_TEXT, "Hello"),
      serialize(STREAM_TOOLCALL, "weather:{"),
      serialize(STREAM_END, "stop"),
      serialize(STREAM_DONE, { usage }),
      serialize(STREAM_ERROR, "soft warning"),
    ];
    const merged = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
    let off = 0;
    for (const frame of frames) {
      merged.set(frame, off);
      off += frame.byteLength;
    }
    const splitAt = Math.floor(merged.byteLength / 2);
    const stream = streamFromChunks([merged.subarray(0, splitAt), merged.subarray(splitAt)]);

    const messages: [number, unknown][] = [];
    for await (const msg of deserialize(stream)) {
      messages.push(msg);
    }

    expect(messages).toEqual([
      [STREAM_START, undefined],
      [STREAM_REASONING, "the"],
      [STREAM_TEXT, "Hello"],
      [STREAM_TOOLCALL, "weather:{"],
      [STREAM_END, "stop"],
      [STREAM_DONE, { usage }],
      [STREAM_ERROR, "soft warning"],
    ]);
  });

  it("parses uint16-length JSON payloads", async () => {
    const big = { x: "y".repeat(300) };
    const frame = serialize(STREAM_DONE, big);
    expect(frame.byteLength).toBeGreaterThan(260);
    const stream = streamFromChunks([frame]);
    const messages: [number, unknown][] = [];
    for await (const msg of deserialize(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([[STREAM_DONE, big]]);
  });

  it("yields nothing for an empty stream", async () => {
    const stream = streamFromChunks([]);
    const messages: [number, unknown][] = [];
    for await (const msg of deserialize(stream)) {
      messages.push(msg);
    }
    expect(messages).toEqual([]);
  });

  it("throws on invalid length encoding bits", () => {
    const head = (STREAM_TEXT << 3) | (0b10 << 1);
    const stream = streamFromChunks([new Uint8Array([head, 0, 0])]);
    const iter = deserialize(stream);
    expect(iter.next()).rejects.toThrow("Invalid message frame");
  });

  it("propagates JSON parse errors for non-raw payloads", () => {
    const head = STREAM_DONE << 3;
    const stream = streamFromChunks([new Uint8Array([head, 3]), new TextEncoder().encode("not")]);
    const iter = deserialize(stream);
    expect(iter.next()).rejects.toThrow();
  });
});

describe("createAIStreamClient", () => {
  it("parses frames and dispatches all callbacks", async () => {
    const events: string[] = [];
    const doneUsage: CompletionUsage[] = [];
    const usage: CompletionUsage = {
      prompt_tokens: 12,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 2 },
    };

    const frames = [
      serialize(STREAM_START),
      serialize(STREAM_REASONING, "the"),
      serialize(STREAM_REASONING, " user"),
      serialize(STREAM_REASONING, " said"),
      serialize(STREAM_REASONING, " 'Hello!'"),
      serialize(STREAM_REASONING, ", I"),
      serialize(STREAM_REASONING, " should"),
      serialize(STREAM_REASONING, " answer"),
      serialize(STREAM_REASONING, " friendly."),
      serialize(STREAM_TEXT, "Hello"),
      serialize(STREAM_TEXT, ", How"),
      serialize(STREAM_TEXT, "can"),
      serialize(STREAM_TEXT, "I"),
      serialize(STREAM_TEXT, "help you"),
      serialize(STREAM_TEXT, "today?"),
      serialize(STREAM_TOOLCALL, "weather:{"),
      serialize(STREAM_TOOLCALL, 'weather:"city"'),
      serialize(STREAM_TOOLCALL, "weather::"),
      serialize(STREAM_TOOLCALL, 'weather:"tokyo"'),
      serialize(STREAM_TOOLCALL, "weather:}"),
      serialize(STREAM_END, "stop"),
      serialize(STREAM_DONE, { usage }),
      serialize(STREAM_ERROR, "soft warning"),
    ];
    const merged = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.byteLength;
    }
    const splitAt = Math.floor(merged.byteLength / 2);
    const chunkA = merged.subarray(0, splitAt);
    const chunkB = merged.subarray(splitAt);

    const fetchMock = mock(async () => {
      return new Response(streamFromChunks([chunkA, chunkB]));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createAIStreamClient({
      onStreamError: (error) => events.push(`error:${error}`),
      onStreamStart: () => events.push("start"),
      onStreamReasoning: (reasoning) => events.push(`reasoning:${reasoning}`),
      onStreamText: (text) => events.push(`text:${text}`),
      onStreamToolCall: (name, args) => events.push(`tool:${name}:${args}`),
      onStreamEnd: (reason) => events.push(`end:${reason}`),
      onStreamDone: (u) => doneUsage.push(u),
    });

    await client.fetch("https://example.com/stream", { model: "test-model" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "start",
      "reasoning:the",
      "reasoning: user",
      "reasoning: said",
      "reasoning: 'Hello!'",
      "reasoning:, I",
      "reasoning: should",
      "reasoning: answer",
      "reasoning: friendly.",
      "text:Hello",
      "text:, How",
      "text:can",
      "text:I",
      "text:help you",
      "text:today?",
      "tool:weather:{",
      'tool:weather:"city"',
      "tool:weather::",
      'tool:weather:"tokyo"',
      "tool:weather:}",
      "end:stop",
      "error:soft warning",
    ]);
    expect(doneUsage).toEqual([usage]);
  });

  it("throws with API error body when response is not ok", () => {
    globalThis.fetch = mock(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const client = createAIStreamClient({});
    expect(client.fetch("https://example.com/fail", {})).rejects.toThrow("Failed to fetch AI: bad request");
  });

  it("deserialize parses a ReadableStream without fetch", async () => {
    const events: string[] = [];
    const doneUsage: CompletionUsage[] = [];
    const usage: CompletionUsage = {
      prompt_tokens: 1,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 0 },
    };

    const frames = [
      serialize(STREAM_START),
      serialize(STREAM_REASONING, "a"),
      serialize(STREAM_TEXT, "Hi"),
      serialize(STREAM_TOOLCALL, "fn:{"),
      serialize(STREAM_END, "stop"),
      serialize(STREAM_DONE, { usage }),
      serialize(STREAM_ERROR, "warn"),
    ];
    const merged = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.byteLength;
    }
    const splitAt = Math.floor(merged.byteLength / 2);
    const stream = streamFromChunks([merged.subarray(0, splitAt), merged.subarray(splitAt)]);

    const client = createAIStreamClient({
      onStreamStart: () => events.push("start"),
      onStreamReasoning: (r) => events.push(`reasoning:${r}`),
      onStreamText: (t) => events.push(`text:${t}`),
      onStreamToolCall: (name, args) => events.push(`tool:${name}:${args}`),
      onStreamEnd: (reason) => events.push(`end:${reason}`),
      onStreamDone: (u) => doneUsage.push(u),
      onStreamError: (e) => events.push(`error:${e}`),
    });

    await client.deserialize(stream);

    expect(events).toEqual([
      "start",
      "reasoning:a",
      "text:Hi",
      "tool:fn:{",
      "end:stop",
      "error:warn",
    ]);
    expect(doneUsage).toEqual([usage]);
  });

  it("deserialize resolves for an empty stream", async () => {
    const spy = mock(() => {});
    const client = createAIStreamClient({
      onStreamStart: spy,
    });
    await client.deserialize(streamFromChunks([]));
    expect(spy).not.toHaveBeenCalled();
  });

  it("deserialize does not call onStreamDone when usage is null", async () => {
    const spy = mock(() => {});
    const client = createAIStreamClient({
      onStreamDone: spy,
    });
    await client.deserialize(streamFromChunks([serialize(STREAM_DONE, { usage: null })]));
    expect(spy).not.toHaveBeenCalled();
  });

  it("deserialize throws on unknown message kind", () => {
    const unknownKind = 7;
    const stream = streamFromChunks([serialize(unknownKind, "payload")]);
    const client = createAIStreamClient({});
    expect(client.deserialize(stream)).rejects.toThrow("Unknown message type");
  });
});

describe("createAIStreamServer", () => {
  it("converts SSE chunks into ai-stream protocol messages", async () => {
    const usage: CompletionUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3 },
    };
    const usageSpy = mock(() => {});

    const server = createAIStreamServer(
      async () =>
        streamFromChunks([
          new TextEncoder().encode(
            [
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"role":"assistant"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":"Let"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":" me"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":" check"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":" the"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"reasoning_content":" weather"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":"Sure"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":","}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":" I"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":" can"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":" help"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":" with"}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"content":" that."}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{"}}]}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"\\"city\\""}}]}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":":"}}]}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"\\"Tokyo\\""}}]}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"}"}}]}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":"tool_calls","delta":{}}]}',
              'data: {"id":"chatcmpl-test123","object":"chat.completion.chunk","created":1713300000,"model":"demo-model","system_fingerprint":"fp_test123","choices":[{"index":0,"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}',
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        ]),
      usageSpy,
    );

    const response = server.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ model: "demo-model", messages: [] }),
      }),
    );

    const clientEvents: string[] = [];
    const doneUsage: CompletionUsage[] = [];

    const fetchMock = mock(async () => response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = createAIStreamClient({
      onStreamStart: () => clientEvents.push("start"),
      onStreamReasoning: (value) => clientEvents.push(`reasoning:${value}`),
      onStreamText: (value) => clientEvents.push(`text:${value}`),
      onStreamToolCall: (name, args) => clientEvents.push(`tool:${name}:${args}`),
      onStreamEnd: (reason) => clientEvents.push(`end:${reason}`),
      onStreamDone: (value) => doneUsage.push(value),
    });

    await client.fetch("https://example.com/ai", { input: true });

    expect(clientEvents).toEqual([
      "start",
      "reasoning:Let",
      "reasoning: me",
      "reasoning: check",
      "reasoning: the",
      "reasoning: weather",
      "text:Sure",
      "text:,",
      "text: I",
      "text: can",
      "text: help",
      "text: with",
      "text: that.",
      "tool:weather:{",
      'tool:weather:"city"',
      "tool:weather::",
      'tool:weather:"Tokyo"',
      "tool:weather:}",
      "end:tool_calls",
      "end:stop",
    ]);
    expect(doneUsage).toEqual([usage]);
    expect(usageSpy).toHaveBeenCalledWith(usage, "demo-model");
  });

  it("reuses the last tool name for partial tool call deltas", async () => {
    const server = createAIStreamServer(
      async () =>
        streamFromChunks([
          new TextEncoder().encode(
            [
              'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{"}}]}}]}',
              'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"city\\""}}]}}]}',
              'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":"}}]}}]}',
              'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Tokyo\\""}}]}}]}',
              'data: {"choices":[{"finish_reason":null,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}',
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        ]),
    );

    const response = server.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ model: "demo-model", messages: [] }),
      }),
    );

    const events: string[] = [];
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch;

    const client = createAIStreamClient({
      onStreamToolCall: (name, args) => events.push(`${name}:${args}`),
    });

    await client.fetch("https://example.com/ai", { input: true });

    expect(events).toEqual([
      "weather:{",
      'weather:"city"',
      "weather::",
      'weather:"Tokyo"',
      "weather:}",
    ]);
  });

  it("accepts CRLF-delimited SSE streams and still emits done usage", async () => {
    const usage: CompletionUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
    };
    const server = createAIStreamServer(
      async () =>
        streamFromChunks([
          new TextEncoder().encode(
            [
              'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\r',
              "data: [DONE]\r",
              "",
            ].join("\n"),
          ),
        ]),
    );

    const response = server.fetch(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ model: "demo-model", messages: [] }),
      }),
    );

    const doneUsage: CompletionUsage[] = [];
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch;

    const client = createAIStreamClient({
      onStreamDone: (value) => doneUsage.push(value),
    });

    await client.fetch("https://example.com/ai", { input: true });

    expect(doneUsage).toEqual([usage]);
  });

  it("saves many bytes compared to SSE JSON blocks for chat deltas", () => {
    const enc = new TextEncoder();
    const id = "chatcmpl-test123";
    const created = 1713300000;
    const model = "demo-model";
    const usage: CompletionUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3 },
    };
    const reasoningChunks = Array.from({ length: 120 }, (_, i) => `r${i % 10}`);
    const textChunks = Array.from({ length: 160 }, (_, i) => `t${i % 10}`);
    const toolArgChunks = Array.from({ length: 80 }, (_, i) => `${i % 10}`);

    const sseLines = [
      `data: ${
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          system_fingerprint: "fp_test123",
          choices: [{ index: 0, finish_reason: null, delta: { role: "assistant" } }],
        })
      }\n`,
      ...reasoningChunks.map(
        (chunk) =>
          `data: ${
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: "fp_test123",
              choices: [{ index: 0, finish_reason: null, delta: { reasoning_content: chunk } }],
            })
          }\n`,
      ),
      ...textChunks.map(
        (chunk) =>
          `data: ${
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: "fp_test123",
              choices: [{ index: 0, finish_reason: null, delta: { content: chunk } }],
            })
          }\n`,
      ),
      ...toolArgChunks.map(
        (chunk) =>
          `data: ${
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              system_fingerprint: "fp_test123",
              choices: [{
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "weather",
                      arguments: chunk,
                    },
                  }],
                },
              }],
            })
          }\n`,
      ),
      `data: ${
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          system_fingerprint: "fp_test123",
          choices: [{ index: 0, finish_reason: "stop", delta: {} }],
          usage,
        })
      }\n`,
      "data: [DONE]\n",
    ];
    const sseBytes = enc.encode(sseLines.join("")).byteLength;

    const binaryFrames = [
      serialize(STREAM_START),
      ...reasoningChunks.map((chunk) => serialize(STREAM_REASONING, chunk)),
      ...textChunks.map((chunk) => serialize(STREAM_TEXT, chunk)),
      ...toolArgChunks.map((chunk) => serialize(STREAM_TOOLCALL, `weather:${chunk}`)),
      serialize(STREAM_END, "stop"),
      serialize(STREAM_DONE, { usage }),
    ];
    const binaryBytes = binaryFrames.reduce((sum, frame) => sum + frame.byteLength, 0);
    const bytesSaved = sseBytes - binaryBytes;

    expect(binaryBytes).toBeLessThan(sseBytes);
    console.log(`${bytesSaved} bytes saved`);
    console.log(`${(bytesSaved / sseBytes * 100).toFixed(2)}% smaller`);
  });
});

describe("computeAICompletionCost", () => {
  it("accounts for cached and uncached prompt tokens", () => {
    const cost = computeAICompletionCost(
      {
        input: 0.15,
        cachedInput: 0.075,
        output: 0.6,
      },
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    );

    expect(cost).toBe(0.000004275);
  });
});
