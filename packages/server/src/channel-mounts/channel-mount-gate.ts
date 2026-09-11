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
  pickFolderNative,
  isServerPickerAllowed,
} from "./channel-mount-service.js";
import type { MountInfo, WorkspaceMountRecord, PickFolderOptions } from "./channel-mount-types.js";

export type { MountInfo, WorkspaceMountRecord, PickFolderOptions };

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
  pickNative: pickFolderNative,
  isServerPickerAllowed,
};
