import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCrowdOSStore } from "./crowdOsStore";
import { apiClient } from "../src/api/client";

describe("CrowdOS Mode Selection, Pinning & Channel Reset Store Suite", () => {
  beforeEach(() => {
    // Reset store state before each test
    vi.restoreAllMocks();
    useCrowdOSStore.setState({
      selectedMode: "auto",
      isPinned: false,
      pinnedModeByChannel: {},
      activeChannelId: "ch-01",
    });
  });

  it("sets mode and updates selectedMode correctly", () => {
    const store = useCrowdOSStore.getState();
    expect(store.selectedMode).toBe("auto");

    store.setMode("coding", "ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("coding");

    store.setMode("chat", "ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("chat");
  });

  // §6: "An unpinned runtime selection is temporary. When the user switches away
  // from the Channel, the Channel returns to Auto." A temporary pick must not
  // be restored on return — only a PIN survives.
  it("resets to auto on channel change when unpinned, and does not restore it on return", () => {
    const store = useCrowdOSStore.getState();
    expect(store.isPinned).toBe(false);

    store.setMode("agentic", "ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("agentic");

    // Leaving discards the temporary selection...
    store.resetOnChannelChange("ch-02");
    expect(useCrowdOSStore.getState().selectedMode).toBe("auto");

    // ...and returning does NOT bring it back — only a pin would.
    store.resetOnChannelChange("ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("auto");
    expect(useCrowdOSStore.getState().isPinned).toBe(false);
  });

  // §6: the pin belongs to the CHANNEL. Pinning in one channel must leave every
  // other channel untouched, and returning to the pinned channel must restore
  // it. The previous suite asserted the opposite (a pin leaking into ch-02 and
  // ch-03), which is exactly the global-flag defect §6 forbids.
  it("keeps a pin scoped to its own channel and restores it on return", () => {
    const store = useCrowdOSStore.getState();
    store.setMode("research", "ch-01");
    store.togglePin();

    expect(useCrowdOSStore.getState().isPinned).toBe(true);
    expect(useCrowdOSStore.getState().selectedMode).toBe("research");
    expect(useCrowdOSStore.getState().pinnedModeByChannel["ch-01"]).toBe("research");

    // Arriving at an unpinned channel must NOT inherit ch-01's pin.
    useCrowdOSStore.getState().resetOnChannelChange("ch-02");
    expect(useCrowdOSStore.getState().selectedMode).toBe("auto");
    expect(useCrowdOSStore.getState().isPinned).toBe(false);

    // Coming back restores the pin.
    useCrowdOSStore.getState().resetOnChannelChange("ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("research");
    expect(useCrowdOSStore.getState().isPinned).toBe(true);
  });

  it("lets two channels hold different pins independently", () => {
    useCrowdOSStore.setState({ activeChannelId: "ch-01", selectedMode: "coding", isPinned: false });
    useCrowdOSStore.getState().togglePin();

    useCrowdOSStore.setState({ activeChannelId: "ch-02", selectedMode: "auto", isPinned: false });
    useCrowdOSStore.getState().setMode("research", "ch-02");
    useCrowdOSStore.getState().togglePin();

    const pinned = useCrowdOSStore.getState().pinnedModeByChannel;
    expect(pinned["ch-01"]).toBe("coding");
    expect(pinned["ch-02"]).toBe("research");
  });

  it("toggles pin status seamlessly", () => {
    const store = useCrowdOSStore.getState();
    expect(store.isPinned).toBe(false);

    store.togglePin();
    expect(useCrowdOSStore.getState().isPinned).toBe(true);

    useCrowdOSStore.getState().togglePin();
    expect(useCrowdOSStore.getState().isPinned).toBe(false);
  });

  // §6: the pin must reach the SERVER, not just localStorage. Before this the
  // server never learned about a pinned runtime, so the Router (which reads
  // channel_settings.pinned_runtime) could never honor one.
  it("persists the pinned runtime to the channel on the server (§6)", async () => {
    const spy = vi.spyOn(apiClient, "updateChannelSettings").mockResolvedValue({} as never);
    useCrowdOSStore.setState({ selectedMode: "coding", isPinned: false, activeChannelId: "ch-42" });

    useCrowdOSStore.getState().togglePin();

    expect(useCrowdOSStore.getState().isPinned).toBe(true);
    // Fire-and-forget: the call is issued synchronously, resolved next tick.
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("ch-42", { pinnedRuntime: "coding" });
  });

  // §22: the server validates pinned_runtime against RUNTIME names, so the
  // composer's `chat` must be translated to `conversational` before the write.
  // Sending the composer name produced a 400 that the fire-and-forget catch
  // swallowed — the UI showed a pin the server had rejected.
  it("translates the composer's Chat mode into the runtime name the server stores (§22)", async () => {
    const spy = vi.spyOn(apiClient, "updateChannelSettings").mockResolvedValue({} as never);
    useCrowdOSStore.setState({ selectedMode: "chat", isPinned: false, activeChannelId: "ch-42" });

    useCrowdOSStore.getState().togglePin();

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith("ch-42", { pinnedRuntime: "conversational" });
    // The composer keeps speaking its own vocabulary.
    expect(useCrowdOSStore.getState().selectedMode).toBe("chat");
  });

  it("hydrates the composer from the channel's server pin (§6)", async () => {
    vi.spyOn(apiClient, "getChannelSettings").mockResolvedValue({
      channelId: "ch-09",
      pinnedRuntime: "conversational",
      activeAgentId: null,
      defaultAgentId: null,
    } as never);
    useCrowdOSStore.setState({ activeChannelId: "ch-09", selectedMode: "auto", isPinned: false });

    await useCrowdOSStore.getState().hydrateChannelPin("ch-09");

    expect(useCrowdOSStore.getState().selectedMode).toBe("chat");
    expect(useCrowdOSStore.getState().isPinned).toBe(true);
  });

  it("leaves the composer unpinned when the channel has no server pin", async () => {
    vi.spyOn(apiClient, "getChannelSettings").mockResolvedValue({
      channelId: "ch-10",
      pinnedRuntime: null,
      activeAgentId: null,
      defaultAgentId: null,
    } as never);
    // A STALE local mirror claims a pin the server does not have. The server
    // row is authoritative, so the composer must fall back to Auto rather than
    // keep showing a mode the server already dropped.
    useCrowdOSStore.setState({
      activeChannelId: "ch-10",
      selectedMode: "research",
      isPinned: true,
      pinnedModeByChannel: { "ch-10": "research" },
    });

    await useCrowdOSStore.getState().hydrateChannelPin("ch-10");

    expect(useCrowdOSStore.getState().isPinned).toBe(false);
    expect(useCrowdOSStore.getState().selectedMode).toBe("auto");
    expect(useCrowdOSStore.getState().pinnedModeByChannel["ch-10"]).toBeUndefined();
  });

  it("clears the server pin when unpinned, and never stores 'auto'", async () => {
    const spy = vi.spyOn(apiClient, "updateChannelSettings").mockResolvedValue({} as never);
    useCrowdOSStore.setState({ selectedMode: "auto", isPinned: false, activeChannelId: "ch-42" });

    // Pinning Auto must write null — Auto is the absence of a pin, not a value.
    useCrowdOSStore.getState().togglePin();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenLastCalledWith("ch-42", { pinnedRuntime: null });

    spy.mockClear();
    useCrowdOSStore.getState().togglePin();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenLastCalledWith("ch-42", { pinnedRuntime: null });
  });

  it("does not block the pin when the server write fails", async () => {
    vi.spyOn(apiClient, "updateChannelSettings").mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useCrowdOSStore.setState({ selectedMode: "research", isPinned: false, activeChannelId: "ch-42" });

    useCrowdOSStore.getState().togglePin();

    // Local state still flips: a failed persist degrades to the old behaviour
    // rather than trapping the user in an unpinned channel.
    expect(useCrowdOSStore.getState().isPinned).toBe(true);
  });
});
