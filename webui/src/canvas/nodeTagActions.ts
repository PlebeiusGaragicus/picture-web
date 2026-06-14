import type { TagDefinition } from '../types';

export const nodeTagActionsRef: {
  updateAssetTags: (nodeId: string, assetId: string, tags: string[]) => void;
  createProjectTag: (tag: TagDefinition) => void;
} = {
  updateAssetTags: () => {},
  createProjectTag: () => {},
};
