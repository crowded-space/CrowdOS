import { describe, it, expect } from "vitest";
import { isSafeHttpUrl } from "./url-guard.js";

describe("url-guard isSafeHttpUrl", () => {
  it("accepts valid public http and https URLs", () => {
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
    expect(isSafeHttpUrl("https://api.github.com/repos")).toBe(true);
    expect(isSafeHttpUrl("https://8.8.8.8/dns")).toBe(true);
  });

  it("rejects non-http protocols", () => {
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("gopher://example.com")).toBe(false);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,test")).toBe(false);
  });

  it("rejects loopback and private networks", () => {
    expect(isSafeHttpUrl("http://localhost:8080")).toBe(false);
    expect(isSafeHttpUrl("http://sub.localhost:3000")).toBe(false);
    expect(isSafeHttpUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isSafeHttpUrl("http://127.0.0.2:8080")).toBe(false);
    expect(isSafeHttpUrl("http://[::1]:8080")).toBe(false);
    expect(isSafeHttpUrl("http://0.0.0.0:8080")).toBe(false);
    expect(isSafeHttpUrl("http://10.0.0.1/test")).toBe(false);
    expect(isSafeHttpUrl("http://172.16.0.1/test")).toBe(false);
    expect(isSafeHttpUrl("http://172.31.255.255/test")).toBe(false);
    expect(isSafeHttpUrl("http://192.168.1.1/admin")).toBe(false);
    expect(isSafeHttpUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("allows private addresses when allowPrivate is true", () => {
    expect(isSafeHttpUrl("http://localhost:8080/v1", true)).toBe(true);
    expect(isSafeHttpUrl("http://127.0.0.1:8080/v1", true)).toBe(true);
    expect(isSafeHttpUrl("http://192.168.1.1/v1", true)).toBe(true);
  });
});
