import { createArtifact, getArtifactById, listArtifactsByRun, listArtifactsByWorkspace, purgeExpiredArtifacts, runArtifactRetentionSweep } from "./artifacts-repository.js";
import type { ArtifactType, CreateArtifactInput, ArtifactRow } from "./artifact-types.js";

export type { ArtifactType, CreateArtifactInput, ArtifactRow };

export const artifactsGate = {
  create: createArtifact,
  getById: getArtifactById,
  listByRun: listArtifactsByRun,
  listByWorkspace: listArtifactsByWorkspace,
  purgeExpired: purgeExpiredArtifacts,
  runRetentionSweep: runArtifactRetentionSweep,
};
