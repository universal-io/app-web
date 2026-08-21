/**
 * The Gateway contract, from the browser's side.
 *
 * The wire format is owned by `universal-io/api-gateway` and documented in its
 * `docs/api-contract.md`. This file mirrors only the parts a web client uses;
 * where the two disagree, the Gateway is right.
 *
 * No AI provider key ever reaches this code. Every model call goes through the
 * Gateway with a Supabase session attached, which is a family-wide rule and the
 * reason a browser client is possible at all.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type Annotation = {
  id: string;
  kind: "highlight" | "callout";
  box: Box;
  label: string;
};

/** What the user indicated on the capture, in the image's own 0-1 space. */
export type Pointer =
  | { kind: "point"; point: { x: number; y: number } }
  | { kind: "region"; region: Box };

export type VisionMode = "observation" | "answer" | "guide" | "clarification";

export type VisionResult = {
  mode: VisionMode;
  message: string;
  observations: string[];
  uncertainties: string[];
  target_candidate_id: string | null;
  annotations: Annotation[];
  /** The injected knowledge, surfaced so the user can see it. Never hidden. */
  skill: { id: string; name: string } | null;
};

export type VisionMeta = {
  model_id?: string;
  fallback_used?: boolean;
  latency_ms?: number;
  notices?: Array<{ severity: string; code: string; message: string }>;
};

export type VisionSuccess = {
  request_id: string;
  capture_id: string;
  result: VisionResult;
  meta: VisionMeta;
};

export type GatewayErrorBody = {
  request_id: string | null;
  error: { code: string; message: string };
};

export class GatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export type AskInput = {
  accessToken: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  question?: string;
  pointer?: Pointer;
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  /**
   * Which language the answer should come back in.
   *
   * Passed in rather than fixed here. This was hard-coded to Japanese, which
   * was invisible while the interface only existed in Japanese and becomes a
   * plain fault the moment it does not: an English page that answers in
   * Japanese is worse than an untranslated one, because the part the user came
   * for is the part in the wrong language.
   */
  outputLanguage: "japanese" | "english";
  signal?: AbortSignal;
};

const PRODUCTION_BASE_URL = "https://api.universal-io.com/api";

/**
 * `??` is the wrong operator for an environment variable, because the value
 * that actually arrives from an unfilled `.env.local` line is "" rather than
 * undefined. That produced a base URL of "", which made every request relative
 * and sent it to the dev server, which answered 404 — a configuration mistake
 * wearing the costume of a missing route.
 */
const configuredBaseURL = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL?.trim();
const BASE_URL = configuredBaseURL
  ? configuredBaseURL.replace(/\/+$/, "")
  : PRODUCTION_BASE_URL;

/**
 * Every request must reach an outcome in bounded time — an answer, or a stated
 * reason. A hung fetch that never settles is the one failure the user cannot
 * act on, so it is given a ceiling here rather than left to the browser's.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export async function askVision(input: AskInput): Promise<VisionSuccess> {
  const requestId = crypto.randomUUID();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/ai/vision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      signal,
      body: JSON.stringify({
        request_id: requestId,
        operation: "vision",
        input: {
          capture_id: crypto.randomUUID(),
          image_base64: input.imageBase64,
          media_type: input.mediaType,
          question: input.question,
          turns: input.turns,
          pointer: input.pointer,
          // The browser can draw on the capture but cannot measure the screen,
          // so coordinates are the only way to point at anything.
          wants_annotations: true,
        },
        preferences: { output_language: input.outputLanguage },
        client: { platform: "web", app_version: "0.1.0" },
      }),
    });
  } catch (error) {
    // Distinguishing these matters: one is "wait and retry", the other is
    // "check your connection", and a single generic message serves neither.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new GatewayError("TIMEOUT", "the gateway did not answer in time");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GatewayError("ABORTED", "the request was aborted");
    }
    throw new GatewayError("NETWORK_ERROR", "could not reach the gateway");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as GatewayErrorBody | null;
    const code = body?.error?.code ?? `HTTP_${response.status}`;
    // A response the Gateway did not write means the request never reached it.
    // Naming the URL that answered turns "something failed" into the one fact
    // that identifies the cause.
    if (!body?.error) {
      throw new GatewayError(
        code,
        `unexpected response from the gateway (HTTP ${response.status}); sent to ${BASE_URL}/ai/vision`,
      );
    }
    // The Gateway's own text is kept as the message: for a code this client
    // does not know a phrase for, what the server said is the only thing that
    // describes what happened. The UI prefers a translated phrase when it has
    // one (app/errors.ts).
    throw new GatewayError(code, body.error.message ?? code);
  }

  const body = (await response.json().catch(() => null)) as VisionSuccess | null;
  if (!body?.result) {
    throw new GatewayError("INVALID_RESULT", "could not read the gateway response");
  }
  // A Gateway that omitted the field is not a reason for the renderer to crash.
  return { ...body, result: { ...body.result, annotations: body.result.annotations ?? [] } };
}

/**
 * The codes this client has its own wording for, in every language it speaks.
 *
 * Everything else falls through to whatever the Gateway said, which is the
 * honest answer for a code we have never seen: a phrase invented here would
 * describe a guess. Kept next to the request so that adding a code the Gateway
 * starts returning means touching one list (app/errors.ts renders them).
 */
export const TRANSLATED_GATEWAY_CODES = [
  "TIMEOUT",
  "ABORTED",
  "NETWORK_ERROR",
  "INVALID_RESULT",
  "UNAUTHENTICATED",
  "REAUTH_REQUIRED",
  "QUOTA_EXCEEDED",
  "PAYMENT_REQUIRED",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
] as const;
