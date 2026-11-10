// Owner and admin operations that need the provider or elevated access:
// storing/testing credentials, verifying models, generating variations, model-based
// classification and invitations.
//
// Callers are signed-in users (the web app's server forwards the user's access token). The
// token is verified with the Auth server here, and each handler authorizes that user against
// the workspace of the record it touches. The service key never leaves this function.

import { runOpsAction } from "../_shared/ops/handlers.ts";
import { createOpenAIProvider } from "../_shared/provider/openai.ts";
import { adminClient, env, json, providerBaseUrl } from "../_shared/edge/runtime.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return json({ ok: false, code: "method_not_allowed", message: "Use POST." }, 405);

    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token)
      return json({ ok: false, code: "unauthorized", message: "Sign in to continue." }, 401);

    const admin = adminClient();
    // Verified against the Auth server on every call: revoked or expired sessions are rejected.
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      return json({ ok: false, code: "unauthorized", message: "Sign in to continue." }, 401);
    }

    let body: { action?: unknown; input?: unknown };
    try {
      body = (await request.json()) as { action?: unknown; input?: unknown };
    } catch {
      return json(
        { ok: false, code: "invalid_request", message: "The request body must be JSON." },
        400,
      );
    }
    if (typeof body.action !== "string") {
      return json({ ok: false, code: "invalid_request", message: "Missing action." }, 400);
    }

    const baseURL = providerBaseUrl();
    try {
      const result = await runOpsAction(
        {
          admin,
          userId: data.user.id,
          createProvider: (apiKey) =>
            createOpenAIProvider({ apiKey, ...(baseURL ? { baseURL } : {}) }),
          siteUrl: env("SITE_URL"),
        },
        body.action,
        (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>,
      );
      // Domain failures are returned with 200 so callers always receive the structured result.
      return json(result);
    } catch (error) {
      // Never echo internals (or anything that could contain a credential) to the caller.
      console.error(
        JSON.stringify({
          event: "ops_error",
          action: body.action,
          message: String(error).slice(0, 500),
        }),
      );
      return json(
        { ok: false, code: "internal_error", message: "The operation failed unexpectedly." },
        500,
      );
    }
  },
};
