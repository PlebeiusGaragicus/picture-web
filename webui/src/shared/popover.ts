import { useEffect, type RefObject } from 'react';

/** Re-run `reposition` while `active`, on window resize and any scroll (capture). */
export function useRepositionOnViewportChange(active: boolean, reposition: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = () => reposition();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [active, reposition]);
}

/** Call `onDismiss` on pointerdown outside all `refs` while `active`. */
export function useDismissOnOutsidePointerDown(
  active: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const handler = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
    // refs is a fresh array each render but its RefObject members are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss]);
}
