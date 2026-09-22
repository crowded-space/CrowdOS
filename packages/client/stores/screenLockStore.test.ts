import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearPin, getPin, setPin } from "../src/config/pin";
import { refreshSocketPin, socket } from "../src/config/socket";
import { useCrowdOSStore } from "./crowdOsStore";
import { isScreenlockError, useScreenLockStore } from "./screenLockStore";

vi.mock("../src/config/socket", () => {
  const connect = vi.fn();
  return {
    refreshSocketPin: vi.fn(),
    socket: { disconnect: vi.fn(() => ({ connect })), connect, __connect: connect },
  };
});

vi.mock("./crowdOsStore", () => {
  const state: { workspaceError: string | null; fetchWorkspaces: (...a: any[]) => Promise<void> } = {
    workspaceError: null,
    fetchWorkspaces: async () => {},
  };
  return {
    useCrowdOSStore: {
      getState: () => state,
      setState: (p: Record<string, unknown>) => Object.assign(state, p),
      __state: state,
    },
  };
});

const mockedSocket = vi.mocked(socket);
const storeState = (useCrowdOSStore as any).__state as {
  workspaceError: string | null;
  fetchWorkspaces: (...a: any[]) => Promise<void>;
};
let nextError: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  nextError = null;
  storeState.workspaceError = null;
  storeState.fetchWorkspaces = async () => {
    storeState.workspaceError = nextError;
  };
  clearPin();
  useScreenLockStore.setState({ locked: false, lastActivity: Date.now() });
});

describe("isScreenlockError", () => {
  it("matches the server 401 message", () => {
    expect(
      isScreenlockError(
        "Screenlock is enabled. Provide the x-pin header.",
      ),
    ).toBe(true);
  });

  it("rejects other backend errors and non-strings", () => {
    expect(isScreenlockError("Backend unavailable — DEMO_FALLBACK is off")).toBe(false);
    expect(isScreenlockError(null)).toBe(false);
    expect(isScreenlockError("")).toBe(false);
  });
});

describe("screenLockStore", () => {
  it("lock() shows the overlay, drops the PIN and disconnects realtime", () => {
    setPin("123456");
    expect(getPin()).toBe("123456");
    useScreenLockStore.getState().lock();
    expect(useScreenLockStore.getState().locked).toBe(true);
    expect(getPin()).toBe("");
    expect(mockedSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("lock() is idempotent", () => {
    useScreenLockStore.getState().lock();
    useScreenLockStore.getState().lock();
    expect(mockedSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("unlockWithPin() accepts a good PIN: re-handshakes and clears the lock", async () => {
    nextError = null;
    const ok = await useScreenLockStore.getState().unlockWithPin("123456");
    expect(ok).toBe(true);
    expect(getPin()).toBe("123456");
    expect(refreshSocketPin).toHaveBeenCalledTimes(1);
    expect(useScreenLockStore.getState().locked).toBe(false);
  });

  it("unlockWithPin() rejects a bad PIN and stays locked", async () => {
    useScreenLockStore.getState().lock();
    nextError = "Screenlock is enabled. Provide x-pin header.";
    const ok = await useScreenLockStore.getState().unlockWithPin("0000");
    expect(ok).toBe(false);
    expect(useScreenLockStore.getState().locked).toBe(true);
  });

  it("unlockWithPin() rejects empty input without touching the backend", async () => {
    const ok = await useScreenLockStore.getState().unlockWithPin("   ");
    expect(ok).toBe(false);
    expect(refreshSocketPin).not.toHaveBeenCalled();
  });
});
