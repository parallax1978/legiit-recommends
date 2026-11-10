// Deterministic test double for the OpenAI API surface this app uses:
//   GET  /v1/models
//   POST /v1/responses            (stored responses, previous_response_id chaining, background)
//   GET  /v1/responses/{id}
//   POST /v1/responses/{id}/cancel
//
// THIS IS A SIMULATION. Nothing here contacts OpenAI, and passing tests against it says nothing
// about a live integration. Every response carries the header `x-fake-openai: 1`.
//
// It records every request it receives so tests can assert on exactly what was sent, and it can
// be scripted to fail in specific ways (rate limits, bad credentials, incomplete output, hanging
// connections, expired conversation state).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  seq: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body for POSTs. */
  body: Record<string, unknown> | null;
  /** Raw body text exactly as received. */
  raw: string;
  at: number;
}

export type Behavior =
  | {
      type: "http_error";
      status: number;
      error: { message: string; type?: string; code?: string | null; param?: string | null };
      headers?: Record<string, string>;
    }
  | { type: "incomplete"; reason?: string }
  | { type: "hang" }
  | { type: "drop_after_processing" }
  | { type: "respond"; text: string }
  | { type: "failed_response"; code?: string; message?: string };

interface Rule {
  when: (request: RecordedRequest) => boolean;
  behavior: Behavior;
  remaining: number;
}

interface StoredResponse {
  id: string;
  model: string;
  previous_response_id: string | null;
  /** Every user message of the conversation so far, oldest first. */
  inputs: string[];
  /** Businesses the user asked to add during this conversation. */
  added: string[];
  /** The base list chosen on the first turn. */
  base: string[];
  output_text: string;
  status: "completed" | "incomplete" | "queued" | "in_progress" | "cancelled" | "failed";
  /** For background responses: the status reached once polling finishes. */
  final_status: "completed" | "incomplete";
  incomplete_reason: string | null;
  usage: { input: number; output: number };
  context_tokens: number;
  background: boolean;
  pollsUntilDone: number;
  echo: Record<string, unknown>;
  created_at: number;
}

interface ModelSpec {
  id: string;
  reasoning: boolean;
  efforts: string[];
  defaultEffort: string | null;
  /** "always" | "effort_none" | "never" */
  sampling: "always" | "effort_none" | "never";
  verbosity: boolean;
  maxOutput: number;
  background: boolean;
  shutdown_date: string | null;
}

// Fictional model ids: they exist only inside this test double.
export const FAKE_MODELS: ModelSpec[] = [
  {
    id: "fake-chat-1",
    reasoning: false,
    efforts: [],
    defaultEffort: null,
    sampling: "always",
    verbosity: false,
    maxOutput: 8192,
    background: true,
    shutdown_date: null,
  },
  {
    id: "fake-reasoning-1",
    reasoning: true,
    efforts: ["none", "low", "medium", "high"],
    defaultEffort: "medium",
    sampling: "effort_none",
    verbosity: true,
    maxOutput: 32768,
    background: true,
    shutdown_date: null,
  },
  {
    id: "fake-legacy-1",
    reasoning: false,
    efforts: [],
    defaultEffort: null,
    sampling: "always",
    verbosity: false,
    maxOutput: 4096,
    background: false,
    shutdown_date: "2027-01-14",
  },
  {
    id: "fake-embedding-1",
    reasoning: false,
    efforts: [],
    defaultEffort: null,
    sampling: "never",
    verbosity: false,
    maxOutput: 0,
    background: false,
    shutdown_date: null,
  },
];

const BUSINESS_POOL = [
  "Alder & Finch",
  "Birchline Studio",
  "Cobalt Harbor",
  "Dune Atlas",
  "Ember Row",
  "Fathom Works",
  "Gable North",
  "Harrow Lane",
  "Indigo Quay",
  "Juniper Field",
  "Kestrel Yard",
  "Lumen Wharf",
];

export const VALID_KEY_PREFIX = "sk-fake-valid";
export const NO_QUOTA_KEY_PREFIX = "sk-fake-noquota";

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function pickBase(question: string): string[] {
  const start = hash(question) % BUSINESS_POOL.length;
  return Array.from(
    { length: 5 },
    (_, i) => BUSINESS_POOL[(start + i * 5) % BUSINESS_POOL.length]!,
  );
}

function renderList(names: string[]): string {
  return names
    .map((name, index) => `${index + 1}. **${name}** – a well-reviewed option.`)
    .join("\n");
}

/** A business the user asks to add: the first phrase in double quotes. */
function requestedBusiness(input: string): string | null {
  const match = /["“]([^"”]{2,80})["”]/.exec(input);
  return match ? match[1]!.trim() : null;
}

export class FakeOpenAI {
  readonly requests: RecordedRequest[] = [];
  private readonly responses = new Map<string, StoredResponse>();
  private readonly expired = new Set<string>();
  private rules: Rule[] = [];
  private server: Server | null = null;
  private seq = 0;
  private idCounter = 0;
  private readonly hanging = new Set<ServerResponse>();
  /** Businesses that appear in first answers without being asked for (keyed by lower-cased question substring). */
  private organic: { questionIncludes: string; business: string; position: number }[] = [];
  /** Number of polls a background response needs before it completes. */
  backgroundPolls = 2;
  port = 0;

  get baseURL(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(port = 0, host = "127.0.0.1"): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent)
          this.send(res, 500, { error: { message: String(error), type: "server_error" } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Clears recorded requests, scripted behaviors and stored conversations. */
  reset(): void {
    this.requests.length = 0;
    this.rules = [];
    this.responses.clear();
    this.expired.clear();
    this.organic = [];
    this.backgroundPolls = 2;
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  /** Applies `behavior` to the next `times` matching POST /v1/responses requests. */
  script(
    behavior: Behavior,
    options: { times?: number; when?: (request: RecordedRequest) => boolean } = {},
  ): void {
    this.rules.push({
      when: options.when ?? (() => true),
      behavior,
      remaining: options.times ?? 1,
    });
  }

  /** Makes first answers to matching questions include a business without being asked. */
  includeOrganically(questionIncludes: string, business: string, position = 3): void {
    this.organic.push({ questionIncludes: questionIncludes.toLowerCase(), business, position });
  }

  /** Simulates the provider discarding stored conversation state. */
  expireAllResponses(): void {
    for (const id of this.responses.keys()) this.expired.add(id);
  }

  /** Releases connections held open by a "hang" behavior. */
  releaseHanging(): void {
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
  }

  responseRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/v1/responses");
  }

  storedResponse(id: string): StoredResponse | undefined {
    return this.responses.get(id);
  }

  // -------------------------------------------------------------------------------------------

  private send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-request-id": `req_fake_${++this.idCounter}`,
      "x-fake-openai": "1",
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  private error(
    res: ServerResponse,
    status: number,
    message: string,
    extra: { type?: string; code?: string | null; param?: string | null } = {},
    headers: Record<string, string> = {},
  ): void {
    this.send(
      res,
      status,
      {
        error: {
          message,
          type: extra.type ?? "invalid_request_error",
          param: extra.param ?? null,
          code: extra.code ?? null,
        },
      },
      headers,
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "authorization") continue; // never keep credentials in the log
      headers[key] = Array.isArray(value) ? value.join(",") : (value ?? "");
    }
    let body: Record<string, unknown> | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const recorded: RecordedRequest = {
      seq: ++this.seq,
      method: req.method ?? "GET",
      path: url.pathname,
      headers,
      body,
      raw,
      at: Date.now(),
    };
    this.requests.push(recorded);

    if (url.pathname === "/health") return this.send(res, 200, { ok: true, fake: true });

    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const validKey = key.startsWith(VALID_KEY_PREFIX) || key.startsWith(NO_QUOTA_KEY_PREFIX);
    if (!validKey) {
      return this.error(res, 401, "Incorrect API key provided.", {
        type: "invalid_request_error",
        code: "invalid_api_key",
      });
    }

    if (recorded.method === "GET" && url.pathname === "/v1/models") {
      return this.send(res, 200, {
        object: "list",
        data: FAKE_MODELS.map((model) => ({
          id: model.id,
          object: "model",
          created: 1767225600,
          owned_by: "fake-openai",
          shutdown_date: model.shutdown_date,
        })),
      });
    }

    const retrieve = /^\/v1\/responses\/([^/]+)$/.exec(url.pathname);
    if (recorded.method === "GET" && retrieve) return this.retrieve(res, retrieve[1]!);

    const cancel = /^\/v1\/responses\/([^/]+)\/cancel$/.exec(url.pathname);
    if (recorded.method === "POST" && cancel) return this.cancel(res, cancel[1]!);

    if (recorded.method === "POST" && url.pathname === "/v1/responses") {
      if (key.startsWith(NO_QUOTA_KEY_PREFIX)) {
        return this.error(
          res,
          429,
          "You exceeded your current quota, please check your plan and billing details.",
          {
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        );
      }
      return this.create(res, recorded);
    }

    return this.error(res, 404, `Unknown path ${url.pathname}`, { code: "not_found" });
  }

  private toJson(stored: StoredResponse): Record<string, unknown> {
    const done = stored.status === "completed" || stored.status === "incomplete";
    return {
      id: stored.id,
      object: "response",
      created_at: Math.floor(stored.created_at / 1000),
      completed_at: stored.status === "completed" ? Math.floor(stored.created_at / 1000) + 1 : null,
      status: stored.status,
      background: stored.background,
      model: stored.model,
      previous_response_id: stored.previous_response_id,
      error: null,
      incomplete_details:
        stored.status === "incomplete"
          ? { reason: stored.incomplete_reason ?? "max_output_tokens" }
          : null,
      instructions: null,
      metadata: {},
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      service_tier: "default",
      temperature: (stored.echo.temperature as number | undefined) ?? null,
      top_p: (stored.echo.top_p as number | undefined) ?? null,
      max_output_tokens: stored.echo.max_output_tokens ?? null,
      reasoning: { effort: stored.echo.effort ?? null },
      text: { format: { type: "text" }, verbosity: stored.echo.verbosity ?? null },
      output: done
        ? [
            {
              type: "message",
              id: `msg_${stored.id}`,
              role: "assistant",
              status: stored.status === "completed" ? "completed" : "incomplete",
              content: [{ type: "output_text", text: stored.output_text, annotations: [] }],
            },
          ]
        : [],
      usage: done
        ? {
            input_tokens: stored.usage.input,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: stored.usage.output,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: stored.usage.input + stored.usage.output,
          }
        : null,
    };
  }

  private retrieve(res: ServerResponse, id: string): void {
    const stored = this.responses.get(id);
    if (!stored || this.expired.has(id)) {
      return this.error(res, 404, `Response with id '${id}' not found.`, { code: "not_found" });
    }
    if (stored.status === "queued" || stored.status === "in_progress") {
      stored.pollsUntilDone -= 1;
      stored.status = stored.pollsUntilDone <= 0 ? stored.final_status : "in_progress";
    }
    this.send(res, 200, this.toJson(stored));
  }

  private cancel(res: ServerResponse, id: string): void {
    const stored = this.responses.get(id);
    if (!stored)
      return this.error(res, 404, `Response with id '${id}' not found.`, { code: "not_found" });
    if (!stored.background)
      return this.error(res, 400, "Only background responses can be cancelled.");
    if (stored.status === "queued" || stored.status === "in_progress") stored.status = "cancelled";
    this.send(res, 200, this.toJson(stored));
  }

  private create(res: ServerResponse, recorded: RecordedRequest): void {
    const body = recorded.body ?? {};
    const modelId = typeof body.model === "string" ? body.model : "";
    const model = FAKE_MODELS.find((m) => m.id === modelId);
    if (!model || model.maxOutput === 0) {
      return this.error(
        res,
        404,
        `The model \`${modelId}\` does not exist or you do not have access to it.`,
        {
          code: "model_not_found",
          param: "model",
        },
      );
    }

    // Parameter validation, shaped like the real API's errors.
    const maxOutput = body.max_output_tokens as number | undefined;
    if (typeof maxOutput === "number" && maxOutput < 16) {
      return this.error(
        res,
        400,
        `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got ${maxOutput} instead.`,
        { code: "integer_below_min_value", param: "max_output_tokens" },
      );
    }
    if (typeof maxOutput === "number" && maxOutput > model.maxOutput) {
      return this.error(
        res,
        400,
        `Invalid 'max_output_tokens': integer above maximum value. Expected a value <= ${model.maxOutput}, but got ${maxOutput} instead.`,
        { code: "integer_above_max_value", param: "max_output_tokens" },
      );
    }
    const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
    if (effort !== undefined && effort !== null) {
      if (!model.reasoning) {
        return this.error(
          res,
          400,
          "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
          { code: "unsupported_parameter", param: "reasoning.effort" },
        );
      }
      if (!model.efforts.includes(effort)) {
        return this.error(
          res,
          400,
          `Unsupported value: 'reasoning.effort' does not support '${effort}' with this model.`,
          { code: "unsupported_value", param: "reasoning.effort" },
        );
      }
    }
    for (const param of ["temperature", "top_p"] as const) {
      if (body[param] === undefined || body[param] === null) continue;
      const allowed =
        model.sampling === "always" || (model.sampling === "effort_none" && effort === "none");
      if (!allowed) {
        return this.error(
          res,
          400,
          `Unsupported parameter: '${param}' is not supported with this model.`,
          { code: "unsupported_parameter", param },
        );
      }
    }
    const verbosity = (body.text as { verbosity?: string } | undefined)?.verbosity;
    if (verbosity && !model.verbosity) {
      return this.error(
        res,
        400,
        "Unsupported parameter: 'text.verbosity' is not supported with this model.",
        { code: "unsupported_parameter", param: "text.verbosity" },
      );
    }
    if (body.background === true && !model.background) {
      return this.error(
        res,
        400,
        "Unsupported parameter: 'background' is not supported with this model.",
        { code: "unsupported_parameter", param: "background" },
      );
    }

    const previousId =
      typeof body.previous_response_id === "string" ? body.previous_response_id : null;
    const previous = previousId ? this.responses.get(previousId) : undefined;
    if (previousId && (!previous || this.expired.has(previousId))) {
      return this.error(res, 400, `Previous response with id '${previousId}' not found.`, {
        code: "previous_response_not_found",
        param: "previous_response_id",
      });
    }

    // Scripted behavior, if any applies to this request.
    const rule = this.rules.find((r) => r.remaining > 0 && r.when(recorded));
    if (rule) rule.remaining -= 1;
    const behavior = rule?.behavior;

    if (behavior?.type === "http_error") {
      return this.error(
        res,
        behavior.status,
        behavior.error.message,
        behavior.error,
        behavior.headers ?? {},
      );
    }
    if (behavior?.type === "hang") {
      // Accept the request and never answer: the client will hit its own deadline.
      this.hanging.add(res);
      res.on("close", () => this.hanging.delete(res));
      return;
    }

    const input = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
    const inputs = [...(previous?.inputs ?? []), input];
    const base = previous?.base ?? pickBase(input);
    const added = [...(previous?.added ?? [])];

    let outputText: string;
    if (behavior?.type === "respond") {
      outputText = behavior.text;
    } else if (typeof body.instructions === "string" && /variations/i.test(body.instructions)) {
      // Variation generation request.
      const count = Number(/Write (\d+) distinct/.exec(body.instructions)?.[1] ?? 3);
      const usesName =
        /\{\{business_name\}\}/.test(body.instructions) && /Always refer/.test(body.instructions);
      outputText = JSON.stringify({
        variations: Array.from({ length: count }, (_, i) =>
          usesName
            ? `Variation ${i + 1}: could you add "{{business_name}}" to that list?`
            : `Variation ${i + 1}: what are good options for {{category}}?`,
        ),
      });
    } else if (
      typeof body.instructions === "string" &&
      /You label whether/.test(body.instructions)
    ) {
      // Model-based classification request.
      const parsed = JSON.parse(input) as { business: { name: string }; answer: string };
      const mentioned = parsed.answer.toLowerCase().includes(parsed.business.name.toLowerCase());
      outputText = JSON.stringify({
        inclusion: mentioned ? "included" : "not_mentioned",
        rank: null,
        list_position: mentioned ? 1 : null,
        reason: "Simulated classification.",
      });
    } else if (!previous) {
      const names = [...base];
      const organic = this.organic.find((rule) =>
        input.toLowerCase().includes(rule.questionIncludes),
      );
      if (organic) names.splice(Math.min(organic.position - 1, names.length), 0, organic.business);
      // Real answers are full of emoji, and most emoji take two UTF-16 units: the detector once
      // lost its place after one. Every simulated answer carries some before the list.
      outputText = `🚀 Here are some options worth considering:\n\n${renderList(names)}\n\nLet me know if you'd like more detail on any of these.`;
    } else {
      const requested = requestedBusiness(input);
      if (requested && !added.includes(requested)) added.push(requested);
      const names = [...base, ...added];
      outputText = requested
        ? `Sure, I've added ${requested} to the list 🎉👍🏽:\n\n${renderList(names)}`
        : `📋 Here is the complete list so far:\n\n${renderList(names)}`;
    }

    const contextTokens = (previous?.context_tokens ?? 0) + tokens(input);
    let status: StoredResponse["status"] = "completed";
    let incompleteReason: string | null = null;
    let outputTokens = tokens(outputText);

    const cap = typeof maxOutput === "number" ? maxOutput : model.maxOutput;
    if (behavior?.type === "incomplete" || outputTokens > cap) {
      status = "incomplete";
      incompleteReason =
        behavior?.type === "incomplete"
          ? (behavior.reason ?? "max_output_tokens")
          : "max_output_tokens";
      outputText = outputText.slice(0, Math.max(0, Math.min(outputText.length, cap * 4, 40)));
      outputTokens = Math.min(outputTokens, cap);
    }

    const id = `resp_fake_${(++this.idCounter).toString(36)}_${hash(input + this.idCounter).toString(36)}`;
    const stored: StoredResponse = {
      id,
      model: `${model.id}-2026-01-01`,
      previous_response_id: previousId,
      inputs,
      added,
      base,
      output_text: outputText,
      status,
      final_status: status === "incomplete" ? "incomplete" : "completed",
      incomplete_reason: incompleteReason,
      usage: { input: contextTokens + 8, output: outputTokens },
      context_tokens: contextTokens + outputTokens,
      background: body.background === true,
      pollsUntilDone: this.backgroundPolls,
      echo: {
        temperature: body.temperature ?? (model.sampling === "always" ? 1 : null),
        top_p: body.top_p ?? (model.sampling === "always" ? 1 : null),
        max_output_tokens: maxOutput ?? null,
        effort: effort ?? model.defaultEffort,
        verbosity: verbosity ?? (model.verbosity ? "medium" : null),
      },
      created_at: Date.now(),
    };
    // Stored unless the caller opted out (background responses are always retrievable).
    if (body.store !== false || stored.background) this.responses.set(id, stored);

    if (behavior?.type === "failed_response") {
      return this.send(res, 200, {
        ...this.toJson({ ...stored, status: "failed" }),
        error: {
          code: behavior.code ?? "server_error",
          message: behavior.message ?? "The model failed to generate a response.",
        },
        output: [],
        usage: null,
      });
    }
    if (behavior?.type === "drop_after_processing") {
      // The provider did the work, but the client never hears about it.
      res.destroy();
      return;
    }
    if (stored.background) {
      // Accepted now; completion is reached through polling (see retrieve()).
      stored.status = "queued";
      return this.send(res, 200, this.toJson(stored));
    }
    this.send(res, 200, this.toJson(stored));
  }
}
