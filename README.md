# ai-octet-stream

Lightweight SDK for streaming AI responses with a compact binary protocol.

- Tiny: 2 KB gzipped
- Minimal API: 3 functions
- Fast transport over a compact binary stream
- Up to 95% smaller payloads than SSE JSON for token-by-token streaming
- Works with any provider that exposes an OpenAI-style chat completion stream; Anthropic-style support is coming soon
- Track completion cost on the server side
- Built on standard Web APIs for browsers, Workers, Bun, and Node

## Usage

`createAIStreamServer()` turns an upstream OpenAI-style SSE stream into the package's compact binary stream format. This matters most when models emit lots of tiny deltas: instead of repeating large JSON envelopes for every token, the server forwards compact binary frames. In the test suite, a synthetic chat stream with hundreds of tiny reasoning, text, and tool-call chunks saves more than 80 KB and cuts payload size by over 95% versus the equivalent SSE JSON stream.

### Using OpenAI SDK

Use the official SDK, then call `.asResponse()` to get the raw SSE response body that `createAIStreamServer()` expects.

```ts
import OpenAI from "openai";
import { createAIStreamServer } from "ai-octet-stream";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = createAIStreamServer(
  async (input: Record<string, unknown>, signal) => {
    const response = await openai.chat.completions
      .create(
        {
          ...input,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      )
      .asResponse();

    if (!response.body) {
      throw new Error("Missing response body");
    }

    return response.body;
  },
  (usage, model) => {
    console.log("usage", model, usage);
  },
);

// POST /api/ai
export async function POST(req: Request) {
  return server.fetch(req);
}
```

### Using Cloudflare Worker AI Binding

If you are running inside a Worker, use the Workers AI binding directly instead of making an extra HTTP request.

```ts
import { env } from "cloudflare:workers";
import { createAIStreamServer } from "ai-octet-stream";

type ChatInput = {
  model: string;
  messages: Array<{ role: string; content: string }>;
};

const server = createAIStreamServer<ChatInput>(async ({ model, ...input }, _signal) => {
  return env.AI.run(model, {
    ...input,
    stream: true,
  });
});

export default {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/ai") {
      return server.fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
};
```

### Using OpenAI-compatible server endpoint

If your provider already exposes an OpenAI-compatible chat completions endpoint, proxy it with `fetch()` and return the response body.

```ts
import { createAIStreamServer } from "ai-octet-stream";

const server = createAIStreamServer(
  async (input: Record<string, unknown>, signal) => {
    const response = await fetch(process.env.OPENAI_BASE_URL + "/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        ...input,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await response.text());
    }

    return response.body;
  },
  (usage, model) => {
    console.log("usage", model, usage);
  },
);

// POST /api/ai
export async function POST(req: Request) {
  return server.fetch(req);
}
```

### Consuming The Binary Stream

Once your server route is in place, consume the binary stream from browsers, Workers, Bun, or Node with the client helper:

```ts
import { createAIStreamClient } from "ai-octet-stream";

const client = createAIStreamClient({
  onStreamError(error) {
    console.error("stream error:", error);
  },
  onStreamStart() {
   console.log("stream started");
  },
  onStreamReasoning(reasoning_delta) {
    console.log("reasoning delta:", reasoning_delta);
  },
  onStreamText(text_delta) {
    console.log("text delta:", text_delta);
  },
  onStreamToolCall(name, arguments_delta) {
    console.log("function:", name, "arguments delta:", arguments_delta);
  },
  onStreamEnd(finish_reason) {
    console.log("stream ended:", finish_reason);
  },
  onStreamDone(usage) {
    console.log("[done] usage:", usage);
  },
});

await client.fetch(
  "/api/ai",
  {
    model: "gpt-5.4",
    messages: [
      { role: "system", content: "You are an AI assistant." },
      { role: "user", content: "Write a haiku." },
    ],
  }
);
```

## Pricing

This package provides a `computeAICompletionCost(pricing, usage)` function to compute the cost of an AI completion.

In `createAIStreamServer`'s second callback, assign the return value to `usage.cost`. That hook runs immediately before the final `STREAM_DONE` frame, so the client can read `usage.cost` in `onStreamDone`.

```ts
import { createAIStreamClient, createAIStreamServer, computeAICompletionCost } from "ai-octet-stream";

const server = createAIStreamServer(
  async (input, signal) => {
    // fetch from the AI provider
  },
  (usage, model) => {
    usage.cost = computeAICompletionCost(
      {
        input: 0.15,
        cachedInput: 0.075,
        output: 0.6,
      },
      usage,
    );
    // update user ai credits balance
    console.log("model", model, "cost", usage.cost);
  },
);

const client = createAIStreamClient({
  onStreamDone(usage) {
    console.log("cost", usage.cost);
  },
});
```

## License

[MIT License](https://opensource.org/licenses/MIT).
