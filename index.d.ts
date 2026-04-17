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
export type ModelPricing = {
  input: number;
  cachedInput: number;
  output: number;
};

/** A client for streaming AI completions */
export type AIStreamClient<T extends Record<string, unknown> = Record<string, unknown>> = {
  fetch(url: string | URL, input: T, options?: Pick<RequestInit, "headers" | "signal">): Promise<void>;
  deserialize(stream: ReadableStream<Uint8Array>): Promise<void>;
};

/** Create a client for streaming AI completions */
export function createAIStreamClient<T extends Record<string, unknown> = Record<string, unknown>>(listener: {
  onStreamError?: (error: string) => void;
  onStreamStart?: () => void;
  onStreamReasoning?: (reasoning_delta: string) => void;
  onStreamText?: (text_delta: string) => void;
  onStreamToolCall?: (function_name: string, arguments_delta: string) => void;
  onStreamEnd?: (finish_reason: string) => void;
  onStreamDone?: (usage: CompletionUsage) => void;
}): AIStreamClient<T>;

/** A server for streaming AI completions */
export type AIStreamServer = {
  fetch(req: Request): Promise<Response>;
};

/** Create a server for streaming AI completions */
export function createAIStreamServer<T extends Record<string, unknown> = Record<string, unknown>>(
  fetchAI: (input: T, signal: AbortSignal) => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
  onUsage?: (usage: CompletionUsage, input: T) => void,
): AIStreamServer;

/** Compute the cost of an AI completion */
export function computeAICompletionCost(pricing: ModelPricing, usage: CompletionUsage): number;
