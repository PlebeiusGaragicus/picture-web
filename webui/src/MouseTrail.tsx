import { useEffect, useRef } from 'react';

type TrailPoint = {
  x: number;
  y: number;
  age: number;
  spark: boolean;
};

const MAX_POINTS = 16;
const MOVE_INTERVAL_MS = 40;
const MIN_MOVE_PX = 5;
const FADE_STEP = 0.06;

export function MouseTrail() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<TrailPoint[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastMoveRef = useRef({ x: 0, y: 0, t: 0 });

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize, { passive: true });

    const tick = () => {
      const points = pointsRef.current;
      if (points.length === 0) {
        rafRef.current = null;
        return;
      }

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      for (let index = points.length - 1; index >= 0; index -= 1) {
        const point = points[index];
        point.age -= FADE_STEP;
        if (point.age <= 0) {
          points.splice(index, 1);
          continue;
        }

        const alpha = point.age;
        const radius = point.spark ? 1.2 + alpha * 2 : 1 + alpha * 1.2;
        ctx.fillStyle = point.spark
          ? `rgba(220, 240, 255, ${alpha * 0.75})`
          : `rgba(140, 180, 220, ${alpha * 0.45})`;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();

        if (point.spark && alpha > 0.55) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(alpha - 0.55) * 1.4})`;
          ctx.beginPath();
          ctx.arc(point.x, point.y, 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    const schedule = () => {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    const onMove = (event: PointerEvent) => {
      const now = performance.now();
      if (now - lastMoveRef.current.t < MOVE_INTERVAL_MS) return;

      const dx = event.clientX - lastMoveRef.current.x;
      const dy = event.clientY - lastMoveRef.current.y;
      if (dx * dx + dy * dy < MIN_MOVE_PX * MIN_MOVE_PX) return;

      lastMoveRef.current = { x: event.clientX, y: event.clientY, t: now };

      const points = pointsRef.current;
      points.push({
        x: event.clientX,
        y: event.clientY,
        age: 1,
        spark: Math.random() < 0.12,
      });
      while (points.length > MAX_POINTS) {
        points.shift();
      }
      schedule();
    };

    window.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return <canvas ref={canvasRef} className="landing-trail" aria-hidden="true" />;
}
