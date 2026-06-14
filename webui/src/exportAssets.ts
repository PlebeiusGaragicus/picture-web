import { assetLabel } from './canvas/shared';
import type { Asset } from './types';

type WritableFileStream = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type FileSystemFileHandle = {
  createWritable: () => Promise<WritableFileStream>;
};

type FileSystemDirectoryHandle = {
  getDirectoryHandle: (name: string, options: { create: boolean }) => Promise<FileSystemDirectoryHandle>;
  getFileHandle: (name: string, options: { create: boolean }) => Promise<FileSystemFileHandle>;
};

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
};

function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || 'untitled';
}

function uniqueFileName(used: Set<string>, base: string): string {
  const stem = sanitizePathSegment(base);
  let candidate = `${stem}.png`;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${counter}.png`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export async function exportProjectAssetsToFolder(projectSlug: string, projectName: string, assets: Asset[]) {
  const pickerWindow = window as WindowWithDirectoryPicker;
  if (!pickerWindow.showDirectoryPicker) {
    throw new Error('Folder export requires Chrome or Edge. This browser cannot choose a save folder.');
  }
  const imageAssets = assets.filter((asset) => asset.hasPixels);
  if (!imageAssets.length) {
    throw new Error('This project has no image assets to export.');
  }
  const parent = await pickerWindow.showDirectoryPicker();
  const directory = await parent.getDirectoryHandle(sanitizePathSegment(projectName), { create: true });
  const used = new Set<string>();
  for (const asset of imageAssets) {
    const response = await fetch(`/api/projects/${projectSlug}/assets/${asset.id}/image`);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${assetLabel(asset)}`);
    }
    const fileName = uniqueFileName(used, asset.title || asset.id);
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(await response.blob());
    await writable.close();
  }
}
