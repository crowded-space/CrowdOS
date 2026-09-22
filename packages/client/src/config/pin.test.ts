// Regression coverage for the header-preserving PIN merge AND the credential
// channel separation.
//
// 1. Header preservation: the global fetch patch attaches the PIN to every
//    /api/* call. Its merge previously used Object.entries(init.headers), which
//    enumerates only the plain-object arm of HeadersInit — a Headers instance
//    yields []. apiClient passes exactly that, so every apiClient request
//    silently lost x-workspace-id and Content-Type. These tests pin all three
//    HeadersInit arms.
// 2. Credential channel: the PIN travels on `x-pin` ONLY. It used to ALSO ride
//    `Authorization: Bearer <pin>`, which the mounted auth gate reads as an API
//    key — a PIN there failed verification and every /api call answered 401
//    "Missing or invalid API key." A screenlock user was locked out of their
//    own local app. `Authorization` belongs to the API key alone.
import { beforeEach, describe, expect, it } from "vitest";

import { clearPin, setPin, withPinHeaders } from "./pin";

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

beforeEach(() => {
  clearPin();
});

describe("withPinHeaders · preserves caller headers on every HeadersInit arm", () => {
  it("keeps headers passed as a Headers instance (the apiClient shape)", () => {
    const init = withPinHeaders({
      method: "GET",
      headers: new Headers({ "x-workspace-id": "ws_1", "Content-Type": "application/json" }),
    });
    expect(headerValue(init.headers, "x-workspace-id")).toBe("ws_1");
    expect(headerValue(init.headers, "Content-Type")).toBe("application/json");
  });

  it("keeps headers passed as a plain object and as a tuple array", () => {
    const fromObject = withPinHeaders({ headers: { "x-workspace-id": "ws_2" } });
    expect(headerValue(fromObject.headers, "x-workspace-id")).toBe("ws_2");

    const fromTuples = withPinHeaders({ headers: [["x-workspace-id", "ws_3"]] });
    expect(headerValue(fromTuples.headers, "x-workspace-id")).toBe("ws_3");
  });

  it("adds the PIN when configured and omits it when not", () => {
    const without = withPinHeaders({ headers: { "x-workspace-id": "ws_4" } });
    expect(headerValue(without.headers, "x-pin")).toBeNull();
    expect(headerValue(without.headers, "x-workspace-id")).toBe("ws_4");

    setPin("s3cret");
    const with_ = withPinHeaders({ headers: { "x-workspace-id": "ws_4" } });
    expect(headerValue(with_.headers, "x-pin")).toBe("s3cret");
    // The PIN must NOT ride Authorization — that header is the API-key channel,
    // and a PIN there made the auth gate reject the request as a bad key.
    expect(headerValue(with_.headers, "Authorization")).toBeNull();
    expect(headerValue(with_.headers, "x-workspace-id")).toBe("ws_4");
  });

  it("never overwrites a caller-supplied credential", () => {
    setPin("held-pin");
    const init = withPinHeaders({ headers: { "x-pin": "caller-pin", Authorization: "Bearer caller-token" } });
    expect(headerValue(init.headers, "x-pin")).toBe("caller-pin");
    expect(headerValue(init.headers, "Authorization")).toBe("Bearer caller-token");
  });

  it("preserves the rest of the init object", () => {
    const init = withPinHeaders({ method: "POST", body: "{}" });
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });
});
