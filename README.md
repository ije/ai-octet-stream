# ai-octet-stream

Lightweight SDK for streaming AI responses with a compact binary protocol.

- Tiny: 2 KB gzipped
- Fast transport over a compact binary stream
- **Up to 95% smaller payloads** than SSE JSON for token-by-token streaming
- Works with any provider that exposes an OpenAI-style chat completion stream; Anthropic-style support is coming soon
- Track completion cost on the server side
- Built on standard Web APIs for browsers, Workers, Bun, and Node

## Usage

`createAIStreamServer()` turns an upstream OpenAI-style SSE stream into the package's compact binary stream format. This matters most when models emit lots of tiny deltas: instead of repeating large JSON envelopes for every token, the server forwards compact binary frames. In the test suite, a synthetic chat stream with hundreds of tiny reasoning, text, and tool-call chunks saves more than 80 KB and cuts payload size by over 95% versus the equivalent SSE JSON stream.

### Using OpenAI SDK

Use the official OpenAI SDK, then call `.asResponse()` to get the raw SSE response body expected by `createAIStreamServer()`.

```ts
import OpenAI from "openai";
import { createAIStreamServer } from "ai-octet-stream";

type ChatInput = {
  model: string;
  messages: Array<{ role: string; content: string }>;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const server = createAIStreamServer<ChatInput>({
  onFetch: async (input, signal) => {
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
    return response.body;
  },
  onUsage: (usage, input) => {
    console.log("usage", input.model, usage);
  },
});

// POST /api/ai
export async function POST(req: Request) {
  return server.fetch(req);
}
```

### Using Cloudflare Worker AI Binding

If you're running in a Cloudflare Worker, call the Workers AI binding directly.

```ts
import { env } from "cloudflare:workers";
import { createAIStreamServer } from "ai-octet-stream";

const server = createAIStreamServer<ChatInput>({
  onFetch: ({ model, ...input }, signal) => {
    return env.AI.run(model, { ...input, stream: true }, { signal });
  },
  onUsage: (usage, input) => {
    console.log("usage", input.model, usage);
  },
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

### Using OpenAI-compatible API

If your provider already exposes an OpenAI-compatible chat completions endpoint, proxy it with `fetch()` and return the response body.

```ts
import { createAIStreamServer } from "ai-octet-stream";

const server = createAIStreamServer<ChatInput>({
  onFetch: async (input: Record<string, unknown>, signal) => {
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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch AI: ${error}`);
    }

    return response.body;
  },
  onUsage: (usage, input) => {
    console.log("usage", input.model, usage);
  },
});

// POST /api/ai
export async function POST(req: Request) {
  return server.fetch(req);
}
```

### Consuming The Binary Stream

Once your server route is in place, consume the binary stream from browsers, Workers, Bun, or Node with the client helper:

```ts
import { createAIStreamClient } from "ai-octet-stream";

const client = createAIStreamClient<ChatInput>({
  onStreamError: (error) => {
    console.error("stream error:", error);
  },
  onStreamStart: () => {
    console.log("stream started");
  },
  onStreamReasoning: (reasoning_delta) => {
    console.log("reasoning delta:", reasoning_delta);
  },
  onStreamText: (text_delta) => {
    console.log("text delta:", text_delta);
  },
  onStreamToolCall: (name, arguments_delta) => {
    console.log("function:", name, "arguments delta:", arguments_delta);
  },
  onStreamEnd: (finish_reason) => {
    console.log("stream ended:", finish_reason);
  },
  onStreamDone: (usage) => {
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

### Stream Rendering

The following example shows how to use `createAIStreamClient` to read the binary stream and render it in a React component.

```tsx
import { useLayoutEffect, useState } from "react";
import { createAIStreamClient } from "ai-octet-stream";

function ChatBot() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [text, setText] = useState("");
  const [finishReason, setFinishReason] = useState("");

  useLayoutEffect(() => {
    const ac = new AbortController();
    const client = createAIStreamClient<ChatInput>({
      onStreamStart: () => {
        setIsStreaming(true);
      },
      onStreamReasoning: (reasoning_delta) => {
        setReasoning((prev) => prev + reasoning_delta);
      },
      onStreamText: (text_delta) => {
        setText((prev) => prev + text_delta);
      },
      onStreamEnd: (finish_reason) => {
        setIsStreaming(false);
        setFinishReason(finish_reason)
      },
    });

    client.fetch(
      "/api/ai",
      {
        model: "gpt-5.4",
        messages: [
          { role: "system", content: "You are an AI assistant." },
          { role: "user", content: "Write a haiku." },
        ],
      },
      { signal: ac.signal }
    );

    return () => ac.abort();
  }, [])

  return (
    <div>
      <h1>Chat Bot</h1>
      <p>
        Status: {isStreaming ? "Streaming" : finishReason ? finishReason : "Pending"}
      </p>
      <p>
        🧠 <pre>{reasoning}</pre>
      </p>
      <p>
        💬 <pre>{text}</pre>
      </p>
    </div>
  );
}
```

## Cost Calculation

This package provides a `computeAICompletionCost(pricing, usage)` function to compute the cost of an AI completion.

In `createAIStreamServer`'s `onUsage` callback, assign the return value to `usage.cost`. That hook runs immediately before the final `STREAM_DONE` frame, so the client can read `usage.cost` in `onStreamDone`.

```ts
import { createAIStreamClient, createAIStreamServer, computeAICompletionCost } from "ai-octet-stream";

const server = createAIStreamServer<ChatInput>({
  onFetch: async (input, signal) => {
    // fetch from the AI provider
  },
  onUsage: (usage, input) => {
    usage.cost = computeAICompletionCost(
      {
        input: 0.15,
        cachedInput: 0.075,
        output: 0.6,
      },
      usage,
    );
    // update user ai credits balance
    console.log("model", input.model, "cost", usage.cost);
  },
});

const client = createAIStreamClient<ChatInput>({
  onStreamDone: (usage) => {
    console.log("cost", usage.cost);
  },
});
```

## License

[MIT License](https://opensource.org/licenses/MIT).
