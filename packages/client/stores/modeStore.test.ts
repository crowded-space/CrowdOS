import { describe, it, expect, beforeEach } from "vitest";
import { useCrowdOSStore } from "./crowd-os-store";

describe("CrowdOS Mode Selection, Pinning & Channel Reset Store Suite", () => {
  beforeEach(() => {
    // Reset store state before each test
    useCrowdOSStore.setState({
      selectedMode: "auto",
      isPinned: false,
      modeByChannel: {},
      activeChannelId: "ch-01",
    });
  });

  it("sets mode and updates selectedMode correctly", () => {
    const store = useCrowdOSStore.getState();
    expect(store.selectedMode).toBe("auto");

    store.setMode("coding", "ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("coding");
    expect(useCrowdOSStore.getState().modeByChannel["ch-01"]).toBe("coding");

    store.setMode("chat", "ch-01");
    expect(useCrowdOSStore.getState().selectedMode).toBe("chat");
  });

  it("resets to auto on channel change when unpinned", () => {
    const store = useCrowdOSStore.getState();
    expect(store.isPinned).toBe(false);

    store.setMode("agentic");
    expect(useCrowdOSStore.getState().selectedMode).toBe("agentic");

    // Switch to a new channel without channel-specific mode
    store.resetOnChannelChange("ch-02");
    expect(useCrowdOSStore.getState().selectedMode).toBe("auto");
  });

  it("preserves pinned mode across channel changes", () => {
    const store = useCrowdOSStore.getState();
    store.setMode("research");
    store.togglePin();

    expect(useCrowdOSStore.getState().isPinned).toBe(true);
    expect(useCrowdOSStore.getState().selectedMode).toBe("research");

    // Switching channels should NOT reset when pinned
    useCrowdOSStore.getState().resetOnChannelChange("ch-02");
    expect(useCrowdOSStore.getState().selectedMode).toBe("research");

    useCrowdOSStore.getState().resetOnChannelChange("ch-03");
    expect(useCrowdOSStore.getState().selectedMode).toBe("research");
  });

  it("toggles pin status seamlessly", () => {
    const store = useCrowdOSStore.getState();
    expect(store.isPinned).toBe(false);

    store.togglePin();
    expect(useCrowdOSStore.getState().isPinned).toBe(true);

    useCrowdOSStore.getState().togglePin();
    expect(useCrowdOSStore.getState().isPinned).toBe(false);
  });
});
