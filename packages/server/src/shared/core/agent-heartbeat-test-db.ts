export interface HeartbeatRuntimeStateRow {
  agentId: string;
  status: string;
  lastHeartbeat: Date | null;
}

export const heartbeatFixture: { staleRuntimeStates: HeartbeatRuntimeStateRow[] } = {
  staleRuntimeStates: [],
};

export const fakeHeartbeatDb = {
  query: {
    runtimeStates: {
      findMany: async () => heartbeatFixture.staleRuntimeStates,
    },
  },
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => ({
            for: async () => heartbeatFixture.staleRuntimeStates,
          }),
        }),
      }),
    }),
  }),
  update: () => ({
    set: () => ({
      where: async () => {},
    }),
  }),
};
