import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatRequestError } from '../formatError';
import type { AdaptationWorkflowStatus } from '../types';

export function useBookSessionLoad(
  projectSlug: string | null,
  onComplete?: () => Promise<void>,
) {
  const [status, setStatus] = useState<AdaptationWorkflowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isLoading = status?.running ?? false;

  const refreshStatus = useCallback(async () => {
    if (!projectSlug) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await api.getBookSessionLoad(projectSlug));
    } catch (err) {
      setError(formatRequestError(err));
    }
  }, [projectSlug]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!projectSlug || !status?.running) return;
    const timer = window.setInterval(async () => {
      const next = await api.getBookSessionLoad(projectSlug);
      setStatus(next);
      if (!next.running) {
        await onComplete?.();
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [onComplete, projectSlug, status?.running]);

  const startLoad = async () => {
    if (!projectSlug) return;
    setError(null);
    try {
      setStatus(await api.startBookSessionLoad(projectSlug));
    } catch (err) {
      setError(formatRequestError(err));
    }
  };

  return { status, error, isLoading, startLoad, refreshStatus };
}
