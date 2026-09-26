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
      // thenable + .returning() so both `await .where(...)` and
      // `await .where(...).returning(...)` work (sweep re-verify path)
      where: () => {
        const rows = [{ agentId: "updated" }];
        const chain = Promise.resolve(rows) as Promise<typeof rows> & { returning: () => Promise<typeof rows> };
        chain.returning = () => Promise.resolve(rows);
        return chain;
      },
    }),
  }),
};
