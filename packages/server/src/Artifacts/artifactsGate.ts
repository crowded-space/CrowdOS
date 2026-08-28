import { createArtifact, getArtifactById, listArtifactsByRun, listArtifactsByWorkspace, listArtifactsByRunAndType, purgeExpiredArtifacts, runArtifactRetentionSweep } from "./artifactsRepository.js";
import type { ArtifactType, CreateArtifactInput, ArtifactRow } from "./artifactTypes.js";

export type { ArtifactType, CreateArtifactInput, ArtifactRow };

export const artifactsGate = {
  create: createArtifact,
  getById: getArtifactById,
  listByRun: listArtifactsByRun,
  listByWorkspace: listArtifactsByWorkspace,
  listByRunAndType: listArtifactsByRunAndType,
  purgeExpired: purgeExpiredArtifacts,
  runRetentionSweep: runArtifactRetentionSweep,
};
