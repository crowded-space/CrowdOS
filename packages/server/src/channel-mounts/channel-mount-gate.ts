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
  resolveEffectiveMounts,
  setEffectiveMounts,
  ownsMountTarget,
} from "./channel-mount-service.js";
import type {
  EffectiveMounts,
  EffectiveRoot,
  FsMount,
  FsMountMode,
  FsMountScope,
  FsMounts,
  MountInfo,
  MountScope,
  WorkspaceMountRecord,
} from "./channel-mount-types.js";

export type {
  EffectiveMounts,
  EffectiveRoot,
  FsMount,
  FsMountMode,
  FsMountScope,
  FsMounts,
  MountInfo,
  MountScope,
  WorkspaceMountRecord,
};

export const channelMountGate = {
  resolve: resolveChannelMount,
  resolveCategory: resolveCategoryMount,
  resolveWorkspace: resolveWorkspaceMount,
  effectiveRoot: resolveEffectiveRoot,
  /** Canon virtual mounts: channel → category → workspace, first override wins. */
  effectiveMounts: resolveEffectiveMounts,
  /** Replace one level's canon virtual mount set (workspace/category/channel). */
  setEffectiveMounts,
  scope: resolveMountScope,
  attachChannel: attachChannelMount,
  attachCategory: attachCategoryMount,
  attachWorkspace: attachWorkspaceMount,
  browse: browseFs,
  validate: validateMountPath,
  allowedRoots: getAllowedRootsList,
  /** CM-003: caller-workspace ownership check for mount targets. */
  owns: ownsMountTarget,
};
