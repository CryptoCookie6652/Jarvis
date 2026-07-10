// Event shapes observed from `claude -p --output-format stream-json --verbose`
// (CLI 2.1.206, smoke-tested 2026-07-09). The CLI adds event types across
// releases — everything downstream must tolerate unknown types without crashing.

export interface BaseEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
}

export interface SystemInitEvent extends BaseEvent {
  type: 'system';
  subtype: 'init';
  cwd: string;
  model: string;
  permissionMode: string;
  apiKeySource: string;
  tools: string[];
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

export interface AssistantEvent extends BaseEvent {
  type: 'assistant';
  message: {
    model?: string;
    content: ContentBlock[];
    usage?: Usage;
  };
}

export interface RateLimitEvent extends BaseEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

export interface ResultEvent extends BaseEvent {
  type: 'result';
  is_error: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Usage;
}

export type WorkerEvent =
  | SystemInitEvent
  | AssistantEvent
  | RateLimitEvent
  | ResultEvent
  | (BaseEvent & Record<string, unknown>);

export function isInit(ev: WorkerEvent): ev is SystemInitEvent {
  return ev.type === 'system' && ev.subtype === 'init';
}

export function isAssistant(ev: WorkerEvent): ev is AssistantEvent {
  return ev.type === 'assistant';
}

export function isResult(ev: WorkerEvent): ev is ResultEvent {
  return ev.type === 'result';
}
