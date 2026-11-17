import { beforeEach, describe, expect, it, vi } from "vitest";

// Harness socket: capture disconnects; connect() chains off disconnect().
const socketMock = vi.hoisted(() => {
  const connect = vi.fn();
  const disconnect = vi.fn(() => ({ connect }));
  return { connect, disconnect };
});
vi.mock("../src/config/socket", () => ({
  socket: {
    on: () => {},
    off: () => {},
    emit: () => {},
    connect: socketMock.connect,
    disconnect: socketMock.disconnect,
  },
  emitChannelJoin: () => {},
  emitChannelLeave: () => {},
  emitWorkspaceLeave: () => {},
  refreshSocketPin: () => {},
}));

import { useCrowdOSStore } from "./crowdOsStore";
import { clearPin, getPin, setPin } from "../src/config/pin";
import { useScreenLockStore } from "./screenLockStore";

const SCREENLOCK_401_BODY = {
  message:
    "Screenlock is enabled. Provide the x-pin header. " +
    "Query-string PIN is disabled (desktop hardening).",
};

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

/** Route the stub to tenant endpoints so the full fetchWorkspaces path runs. */
function stubTenantBackend(roster: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as Request).url ?? input);
      if (url.includes("/api/workspaces")) return res(true, 200, roster);
      return res(true, 200, []);
    }),
  );
}

const roster = [
  {
    id: "ws-lock",
    name: "Locked Nest",
    icon: "crow-indigo-circle",
    screenLockEnabled: true,
    database: { configured: false },
    createdAt: new Date().toISOString(),
  },
];

beforeEach(() => {
  vi.unstubAllGlobals();
  clearPin();
  useScreenLockStore.setState({ locked: false, lastActivity: Date.now() });
  useCrowdOSStore.setState({
    workspaces: [],
    agents: [],
    approvalRequests: [],
    workspaceError: null,
    activeWorkspaceId: "ws-lock",
    activeChannelId: null,
  } as any);
});

describe("screenlock unlock verdict (audit §2.6)", () => {
  it("records the screenlock 401 in workspaceError before locking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(false, 401, SCREENLOCK_401_BODY)),
    );
    await useCrowdOSStore.getState().fetchWorkspaces();

    const state = useCrowdOSStore.getState();
    expect(state.workspaceError).toMatch(/screenlock/i);
    expect(useScreenLockStore.getState().locked).toBe(true);
  });

  it("rejects a wrong PIN: stays locked and does not leave the entered PIN active", async () => {
    stubTenantBackend(roster);
    useScreenLockStore.getState().lock();
    expect(useScreenLockStore.getState().locked).toBe(true);

    // The roster probe answers 401 while the PIN is wrong.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(false, 401, SCREENLOCK_401_BODY)),
    );
    const ok = await useScreenLockStore.getState().unlockWithPin("0000");

    expect(ok).toBe(false);
    expect(useScreenLockStore.getState().locked).toBe(true);
    // The wrong PIN must not stay installed as the active credential.
    expect(getPin()).toBe("");
  });

  it("accepts the correct PIN after a failed attempt (no stale verdict)", async () => {
    stubTenantBackend(roster);
    useScreenLockStore.getState().lock();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(false, 401, SCREENLOCK_401_BODY)),
    );
    expect(await useScreenLockStore.getState().unlockWithPin("0000")).toBe(false);

    // Correct PIN from here on.
    stubTenantBackend(roster);
    const ok = await useScreenLockStore.getState().unlockWithPin("1234");

    expect(ok).toBe(true);
    expect(useScreenLockStore.getState().locked).toBe(false);
    expect(getPin()).toBe("1234");
  });

  it("keeps the locked socket posture after a rejected attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res(false, 401, SCREENLOCK_401_BODY)),
    );
    useScreenLockStore.getState().lock();
    socketMock.disconnect.mockClear();

    await useScreenLockStore.getState().unlockWithPin("0000");

    // Probe reconnected the socket; the rejection must disconnect again
    // (1: unlock probe, 2: locked posture restored after the rejection).
    expect(socketMock.disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
