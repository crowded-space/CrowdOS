import {
  resolveChannelMount,
  resolveCategoryMount,
  resolveWorkspaceMount,
  attachChannelMount,
  attachCategoryMount,
  attachWorkspaceMount,
  browseFs,
  validateMountPath,
  getAllowedRootsList,
  resolveEffectiveRoot,
  resolveMountScope,
} from "./channel-mount-service.js";
import type { EffectiveRoot, MountInfo, MountScope, WorkspaceMountRecord } from "./channel-mount-types.js";

export type { EffectiveRoot, MountInfo, MountScope, WorkspaceMountRecord };

export const channelMountGate = {
  resolve: resolveChannelMount,
  resolveCategory: resolveCategoryMount,
  resolveWorkspace: resolveWorkspaceMount,
  effectiveRoot: resolveEffectiveRoot,
  scope: resolveMountScope,
  attachChannel: attachChannelMount,
  attachCategory: attachCategoryMount,
  attachWorkspace: attachWorkspaceMount,
  browse: browseFs,
  validate: validateMountPath,
  allowedRoots: getAllowedRootsList,
};
