import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatRequestError } from '../formatError';
import { api } from '../api';
import type { Asset, CanvasDocument, StoryPanelDocument, TagDefinition } from '../types';
import { sortedPanels } from './storyPanelUtils';

const emptyCanvas: CanvasDocument = { version: 2, viewport: { x: 0, y: 0, zoom: 1 }, nodes: {} };

export function useStoryPanelDocument(projectSlug: string, options?: { withCanvasContext?: boolean }) {
  const withCanvasContext = options?.withCanvasContext ?? false;
  const [bookText, setBookText] = useState('');
  const [document, setDocument] = useState<StoryPanelDocument | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [projectTags, setProjectTags] = useState<TagDefinition[]>([]);
  const [canvas, setCanvas] = useState<CanvasDocument>(emptyCanvas);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [book, panels] = await Promise.all([
        api.getStoryPanelBook(projectSlug),
        api.getStoryPanels(projectSlug),
      ]);
      setBookText(book.text);
      setDocument(panels);
      if (withCanvasContext) {
        const [projectDetail, nextCanvas] = await Promise.all([
          api.getProject(projectSlug),
          api.getCanvas(projectSlug),
        ]);
        setAssets(projectDetail.assets);
        setProjectTags(projectDetail.tags);
        setCanvas(nextCanvas);
      }
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectSlug, withCanvasContext]);

  useEffect(() => {
    void load();
  }, [load]);

  const panels = useMemo(() => sortedPanels(document?.panels ?? []), [document]);
  const storyPanels = useMemo(() => panels.filter((panel) => panel.sourceKind === 'story'), [panels]);

  const saveDocument = async (nextDocument: StoryPanelDocument) => {
    setIsSaving(true);
    setError(null);
    try {
      const saved = await api.saveStoryPanels(projectSlug, nextDocument);
      setDocument(saved);
    } catch (err) {
      setError(formatRequestError(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deletePanel = async (panelId: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const next = await api.deleteStoryPanel(projectSlug, panelId);
      setDocument(next);
      return next;
    } catch (err) {
      setError(formatRequestError(err));
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  return {
    bookText,
    document,
    panels,
    storyPanels,
    isLoading,
    isSaving,
    error,
    setError,
    setDocument,
    saveDocument,
    deletePanel,
    assets,
    projectTags,
    canvas,
    reload: load,
  };
}
