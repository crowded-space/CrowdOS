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
} from "./channel-mount-service.js";
import type { MountInfo, WorkspaceMountRecord } from "./channel-mount-types.js";

export type { MountInfo, WorkspaceMountRecord };

export const channelMountGate = {
  resolve: resolveChannelMount,
  resolveCategory: resolveCategoryMount,
  resolveWorkspace: resolveWorkspaceMount,
  attachChannel: attachChannelMount,
  attachCategory: attachCategoryMount,
  attachWorkspace: attachWorkspaceMount,
  browse: browseFs,
  validate: validateMountPath,
  allowedRoots: getAllowedRootsList,
};
