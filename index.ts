import { STREAM_DONE, STREAM_END, STREAM_ERROR, STREAM_REASONING, STREAM_START, STREAM_TEXT, STREAM_TOOLCALL } from "./message-type.ts";
import { deserialize, readSSEStream, serialize } from "./serialize.ts";

/** Usage information for a completion */
export type CompletionUsage = {
  prompt_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens: number;
  cost?: number;
};

/** Pricing for a model in dollars per million tokens */
type ModelPricing = {
  input: number;
  cachedInput: number;
  output: number;
};

/** A chunk from a ChatCompletion stream */
type ChatCompletionChunk = {
  choices?: Choice[];
  usage?: CompletionUsage;
};

/** A choice from a ChatCompletion chunk */
type Choice = {
  finish_reason?: string | null;
  delta?: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolOutput[];
  };
  error?: {
    code: number;
    message: string;
    metadata?: Record<string, unknown>;
  };
};

/** A tool call from a Workers AI completion */
type ToolOutput = {
  id?: string;
  index?: number;
  type: "function";
  function: {
    name?: string;
    arguments?: string;
  };
};

/** A promise that may be a promise or a value */
type MaybePromise<T> = T | Promise<T>;

/** Create a client for streaming AI completions */
export function createAIStreamClient<T extends Record<string, unknown> = Record<string, unknown>>(listener: {
  onStreamError?: (error: string) => void;
  onStreamStart?: () => void;
  onStreamReasoning?: (reasoning_delta: string) => void;
  onStreamText?: (text_delta: string) => void;
  onStreamToolCall?: (function_name: string, arguments_delta: string) => void;
  onStreamEnd?: (finish_reason: string) => void;
  onStreamDone?: (usage: CompletionUsage) => void;
}) {
  return {
    async fetch(url: string | URL, input: T, options?: { headers?: HeadersInit; signal?: AbortSignal }) {
      const response = await fetch(url, {
        ...options,
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to fetch AI: ${error}`);
      }
      return this.deserialize(response.body!);
    },
    async deserialize(stream: ReadableStream<Uint8Array>) {
      for await (const [kind, payload] of deserialize(stream)) {
        switch (kind) {
          case STREAM_ERROR:
            if (typeof payload === "string") {
              listener.onStreamError?.(payload);
            }
            break;
          case STREAM_START:
            listener.onStreamStart?.();
            break;
          case STREAM_REASONING:
            if (typeof payload === "string") {
              listener.onStreamReasoning?.(payload);
            }
            break;
          case STREAM_TEXT:
            if (typeof payload === "string") {
              listener.onStreamText?.(payload);
            }
            break;
          case STREAM_TOOLCALL:
            if (typeof payload === "string") {
              const i = payload.indexOf(":");
              if (i >= 0 && listener.onStreamToolCall) {
                listener.onStreamToolCall(payload.slice(0, i), payload.slice(i + 1));
              }
            }
            break;
          case STREAM_END:
            if (typeof payload === "string") {
              listener.onStreamEnd?.(payload);
            }
            break;
          case STREAM_DONE:
            if (payload && typeof payload === "object" && "usage" in payload) {
              const usage = (payload as { usage: CompletionUsage | null }).usage;
              if (usage) {
                listener.onStreamDone?.(usage);
              }
            }
            break;
          default:
            throw new Error("Unknown message type");
        }
      }
    },
  };
}

/** Create a server for streaming AI completions */
export function createAIStreamServer<T extends Record<string, unknown> = Record<string, unknown>>(listener: {
  onFetch: (input: T, signal: AbortSignal) => MaybePromise<ReadableStream<Uint8Array<ArrayBufferLike>>>;
  onUsage?: (usage: CompletionUsage, input: T) => void;
}) {
  return {
    async fetch(req: Request) {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      let ac = new AbortController();
      let toolCallNames = new Map<string, string>();
      let usage: CompletionUsage | null = null;
      let stream: ReadableStream<Uint8Array<ArrayBufferLike>>;
      let input: T;
      try {
        input = await req.json();
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new Error("Invalid input");
        }
      } catch (error) {
        return new Response(error.message, { status: 400 });
      }
      try {
        stream = await listener.onFetch(input as T, ac.signal);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
      }
      return new Response(
        new ReadableStream({
          start: async (controller) => {
            const send = (messageType: number, payload?: unknown) => controller.enqueue(serialize(messageType, payload));
            try {
              send(STREAM_START);
              for await (const rawData of readSSEStream(stream)) {
                if (rawData === "[DONE]") {
                  if (usage) {
                    listener.onUsage?.(usage, input);
                  }
                  send(STREAM_DONE, { usage });
                  break;
                }
                if (rawData.charCodeAt(0) !== /* { */ 123) {
                  continue;
                }
                let chunk: ChatCompletionChunk | null = null;
                try {
                  chunk = JSON.parse(rawData);
                } catch {
                  // ignore malformed data
                }
                if (chunk) {
                  if (chunk.usage) {
                    usage = chunk.usage;
                  }
                  const choice = chunk.choices?.[0];
                  if (!choice) {
                    continue;
                  }
                  const { error, finish_reason, delta } = choice;
                  if (error) {
                    send(STREAM_ERROR, error.message);
                    break;
                  }
                  if (finish_reason) {
                    send(STREAM_END, finish_reason);
                    continue;
                  }
                  if (delta) {
                    const { content, reasoning_content, tool_calls } = delta;
                    if (reasoning_content) {
                      send(STREAM_REASONING, reasoning_content);
                    } else if (content) {
                      send(STREAM_TEXT, content);
                    } else if (tool_calls) {
                      for (let i = 0; i < tool_calls.length; i++) {
                        const { function: fn, id, index } = tool_calls[i];
                        const toolCallKey = index !== undefined ? "idx:" + index : (id ?? "pos:" + i);
                        const functionName = fn.name ?? toolCallNames.get(toolCallKey);
                        if (functionName) {
                          toolCallNames.set(toolCallKey, functionName);
                          if (fn.arguments) {
                            send(STREAM_TOOLCALL, functionName + ":" + fn.arguments);
                          }
                        }
                      }
                    }
                  }
                }
              }
            } catch (error) {
              send(STREAM_ERROR, error.message);
            } finally {
              controller.close();
            }
          },
          cancel: () => ac.abort(),
        }),
        {
          headers: {
            "content-type": "application/octet-stream",
          },
        },
      );
    },
  };
}

/** Compute the cost of a completion in dollars */
export function computeAICompletionCost(pricing: ModelPricing, usage: CompletionUsage): number {
  const prompt = usage.prompt_tokens;
  const cachedPrompt = Math.min(prompt, usage.prompt_tokens_details?.cached_tokens ?? 0);
  const uncachedPrompt = prompt - cachedPrompt;
  const completion = usage.completion_tokens;

  // Scale factor so per-token dollar amounts stay in a range where `Math.round`
  // yields stable results despite IEEE-754 noise.
  const mul = 1e10;

  const inputMul = pricing.input * mul;
  const cachedInputMul = pricing.cachedInput * mul;
  const outputMul = pricing.output * mul;
  const total = inputMul * uncachedPrompt + cachedInputMul * cachedPrompt + outputMul * completion;
  return Math.round(total / 1_000_000) / mul;
}
