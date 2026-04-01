import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useGuardianStore, type GuardianMood } from '@/stores/guardian';

const STORAGE_KEY = 'chitti-avatar-position';
const AVATAR_SIZE = 56;
const DRAG_THRESHOLD = 5;

interface Position {
  x: number;
  y: number;
}

function getDefaultPosition(): Position {
  return {
    x: window.innerWidth - AVATAR_SIZE - 24,
    y: window.innerHeight - AVATAR_SIZE - 24,
  };
}

function loadPosition(): Position {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const pos = JSON.parse(stored) as Position;
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        return clampPosition(pos);
      }
    }
  } catch { /* use default */ }
  return getDefaultPosition();
}

function savePosition(pos: Position): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch { /* storage full */ }
}

function clampPosition(pos: Position): Position {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth - AVATAR_SIZE)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - AVATAR_SIZE)),
  };
}

const MOOD_COLORS: Record<GuardianMood, { glow: string; bg: string; particle: string }> = {
  COMPOSED:      { glow: '0 0 18px 4px rgba(45,212,191,0.45), 0 0 40px 8px rgba(96,165,250,0.2)',  bg: 'linear-gradient(135deg, #0d9488 0%, #2563eb 100%)', particle: 'rgba(45,212,191,0.5)'  },
  ALERT:         { glow: '0 0 20px 6px rgba(251,191,36,0.55), 0 0 44px 10px rgba(250,204,21,0.25)', bg: 'linear-gradient(135deg, #d97706 0%, #eab308 100%)', particle: 'rgba(251,191,36,0.55)' },
  FOCUSED:       { glow: '0 0 22px 6px rgba(34,211,238,0.5), 0 0 40px 8px rgba(255,255,255,0.15)',  bg: 'linear-gradient(135deg, #06b6d4 0%, #e2e8f0 100%)', particle: 'rgba(34,211,238,0.5)'  },
  CAUTIOUS:      { glow: '0 0 18px 5px rgba(248,113,113,0.5), 0 0 38px 8px rgba(251,146,60,0.2)',   bg: 'linear-gradient(135deg, #dc2626 0%, #ea580c 100%)',  particle: 'rgba(248,113,113,0.5)' },
  CELEBRATORY:   { glow: '0 0 22px 6px rgba(52,211,153,0.55), 0 0 48px 12px rgba(34,197,94,0.2)',   bg: 'linear-gradient(135deg, #059669 0%, #22c55e 100%)',  particle: 'rgba(52,211,153,0.55)' },
  REFLECTIVE:    { glow: '0 0 20px 5px rgba(192,132,252,0.5), 0 0 42px 10px rgba(139,92,246,0.2)',  bg: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)',  particle: 'rgba(192,132,252,0.5)' },
  VIGILANT:      { glow: '0 0 20px 6px rgba(59,130,246,0.55), 0 0 44px 10px rgba(99,102,241,0.25)', bg: 'linear-gradient(135deg, #2563eb 0%, #6366f1 100%)',  particle: 'rgba(59,130,246,0.55)' },
  CONTEMPLATIVE: { glow: '0 0 18px 4px rgba(99,102,241,0.45), 0 0 38px 8px rgba(148,163,184,0.2)',  bg: 'linear-gradient(135deg, #6366f1 0%, #64748b 100%)',  particle: 'rgba(99,102,241,0.45)' },
};

const MOOD_ACCENT: Record<GuardianMood, string> = {
  COMPOSED:      '#0d9488',
  ALERT:         '#d97706',
  FOCUSED:       '#06b6d4',
  CAUTIOUS:      '#dc2626',
  CELEBRATORY:   '#059669',
  REFLECTIVE:    '#7c3aed',
  VIGILANT:      '#2563eb',
  CONTEMPLATIVE: '#6366f1',
};

const MOOD_GLOW_SPEED: Record<GuardianMood, number> = {
  COMPOSED: 3,
  ALERT: 1.4,
  FOCUSED: 4,
  CAUTIOUS: 3.5,
  CELEBRATORY: 1.8,
  REFLECTIVE: 5,
  VIGILANT: 1,
  CONTEMPLATIVE: 7,
};

const PARTICLE_COUNT = 8;

function buildParticles(mood: GuardianMood) {
  const color = MOOD_COLORS[mood].particle;
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const angle = (360 / PARTICLE_COUNT) * i;
    const radius = 32 + Math.random() * 6;
    const duration = 4 + Math.random() * 4;
    const delay = -(Math.random() * duration);
    const size = 2 + Math.random();
    const opacity = 0.3 + Math.random() * 0.3;
    return { angle, radius, duration, delay, size, opacity, color };
  });
}

const KEYFRAMES = `
@keyframes guardian-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.05); }
}

@keyframes guardian-glow-pulse {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

@keyframes guardian-orbit {
  0%   { transform: rotate(var(--start-angle)) translateX(var(--radius)) rotate(calc(-1 * var(--start-angle))); opacity: var(--p-opacity); }
  50%  { transform: rotate(calc(var(--start-angle) + 180deg)) translateX(var(--radius)) rotate(calc(-1 * (var(--start-angle) + 180deg))); opacity: calc(var(--p-opacity) * 0.5); }
  100% { transform: rotate(calc(var(--start-angle) + 360deg)) translateX(var(--radius)) rotate(calc(-1 * (var(--start-angle) + 360deg))); opacity: var(--p-opacity); }
}

@keyframes guardian-sparkle {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50%      { opacity: 0.8; transform: scale(1.8); }
}
`;

function ChibiEyes({ mood, accentColor }: { mood: GuardianMood; accentColor: string }) {
  switch (mood) {
    case 'COMPOSED':
      return (
        <>
          <path d="M20 20 Q23 17 26 20" stroke={accentColor} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M30 20 Q33 17 36 20" stroke={accentColor} strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      );
    case 'ALERT':
      return (
        <>
          <circle cx="23" cy="19" r="3" fill={accentColor} opacity="0.3" />
          <circle cx="23" cy="19" r="2" fill={accentColor} />
          <circle cx="24" cy="18" r="0.8" fill="white" opacity="0.8" />
          <circle cx="33" cy="19" r="3" fill={accentColor} opacity="0.3" />
          <circle cx="33" cy="19" r="2" fill={accentColor} />
          <circle cx="34" cy="18" r="0.8" fill="white" opacity="0.8" />
        </>
      );
    case 'FOCUSED':
      return (
        <>
          <rect x="20" y="18" width="6" height="3" rx="1" fill={accentColor} opacity="0.9" />
          <rect x="30" y="18" width="6" height="3" rx="1" fill={accentColor} opacity="0.9" />
        </>
      );
    case 'CAUTIOUS':
      return (
        <>
          <path d="M20 21 Q23 18 26 21" stroke={accentColor} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M30 21 Q33 18 36 21" stroke={accentColor} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M20 17 L26 18.5" stroke={accentColor} strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.5" />
          <path d="M36 18.5 L30 17" stroke={accentColor} strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.5" />
        </>
      );
    case 'CELEBRATORY':
      return (
        <>
          <path d="M20 20 Q23 15 26 20" stroke={accentColor} strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M30 20 Q33 15 36 20" stroke={accentColor} strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </>
      );
    case 'REFLECTIVE':
      return (
        <>
          <circle cx="23" cy="20" r="2.5" fill={accentColor} opacity="0.3" />
          <circle cx="23" cy="21" r="1.5" fill={accentColor} />
          <circle cx="33" cy="20" r="2.5" fill={accentColor} opacity="0.3" />
          <circle cx="33" cy="21" r="1.5" fill={accentColor} />
        </>
      );
    case 'VIGILANT':
      return (
        <>
          <path d="M20 20 L23 17 L26 20" stroke={accentColor} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M30 20 L33 17 L36 20" stroke={accentColor} strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'CONTEMPLATIVE':
      return (
        <>
          <circle cx="23" cy="20" r="2.5" fill={accentColor} opacity="0.25" />
          <circle cx="23" cy="20" r="1.5" fill={accentColor} opacity="0.7" />
          <circle cx="33" cy="20" r="2.5" fill={accentColor} opacity="0.25" />
          <circle cx="33" cy="20" r="1.5" fill={accentColor} opacity="0.7" />
        </>
      );
  }
}

function ChibiMouth({ mood }: { mood: GuardianMood }) {
  const c = MOOD_ACCENT[mood];
  switch (mood) {
    case 'COMPOSED':
      return <path d="M24 27 Q28 29 32 27" stroke={c} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.7" />;
    case 'ALERT':
      return <ellipse cx="28" cy="27" rx="2.5" ry="1.5" fill={c} opacity="0.5" />;
    case 'FOCUSED':
      return <line x1="24" y1="27" x2="32" y2="27" stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />;
    case 'CAUTIOUS':
      return <path d="M24 28 Q28 26 32 28" stroke={c} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.6" />;
    case 'CELEBRATORY':
      return <path d="M23 26 Q28 31 33 26" stroke={c} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.8" />;
    case 'REFLECTIVE':
      return <path d="M25 27 Q28 29 31 27" stroke={c} strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.5" />;
    case 'VIGILANT':
      return <line x1="24" y1="27" x2="32" y2="27" stroke={c} strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />;
    case 'CONTEMPLATIVE':
      return <path d="M25 28 Q28 29 31 28" stroke={c} strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.5" />;
  }
}

function ChibiAccessories({ mood, accentColor }: { mood: GuardianMood; accentColor: string }) {
  switch (mood) {
    case 'COMPOSED':
    case 'ALERT':
    case 'CAUTIOUS':
    case 'REFLECTIVE':
      return null;
    case 'FOCUSED':
      return <path d="M38 10 Q39.5 13 38 16 Q36.5 13 38 10Z" fill="#67e8f9" opacity="0.8" />;
    case 'CELEBRATORY':
      return (
        <>
          <g transform="translate(12,8)">
            <path d="M0-3 L.8-.8 L3 0 L.8 .8 L0 3 L-.8 .8 L-3 0 L-.8-.8Z" fill={accentColor} opacity="0.9" />
          </g>
          <g transform="translate(44,8)">
            <path d="M0-2.5 L.6-.6 L2.5 0 L.6 .6 L0 2.5 L-.6 .6 L-2.5 0 L-.6-.6Z" fill={accentColor} opacity="0.9" />
          </g>
          <g transform="translate(10,16)">
            <path d="M0-2 L.5-.5 L2 0 L.5 .5 L0 2 L-.5 .5 L-2 0 L-.5-.5Z" fill={accentColor} opacity="0.6" />
          </g>
        </>
      );
    case 'VIGILANT':
      return (
        <>
          <rect x="27" y="2" width="2" height="4" rx="1" fill={accentColor} />
          <circle cx="28" cy="8" r="1" fill={accentColor} />
        </>
      );
    case 'CONTEMPLATIVE':
      return (
        <>
          <circle cx="42" cy="14" r="1.2" fill="white" opacity="0.6" />
          <circle cx="45" cy="11" r="1.5" fill="white" opacity="0.6" />
          <circle cx="49" cy="8" r="2" fill="white" opacity="0.6" />
        </>
      );
  }
}

function ChibiTrader({ mood, accentColor }: { mood: GuardianMood; accentColor: string }) {
  return (
    <svg viewBox="0 0 56 56" className="w-full h-full" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="helmet-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#334155" />
          <stop offset="100%" stopColor="#1e293b" />
        </linearGradient>
        <linearGradient id="visor-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={accentColor} stopOpacity="0.9" />
          <stop offset="100%" stopColor={accentColor} stopOpacity="0.5" />
        </linearGradient>
        <filter id="glow-f">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect x="26" y="2" width="4" height="6" rx="2" fill="#475569" />
      <circle cx="28" cy="2" r="2.5" fill={accentColor} opacity="0.8" />

      <circle cx="28" cy="22" r="14" fill="url(#helmet-grad)" />
      <circle cx="28" cy="22" r="12.5" fill="#1e293b" />

      <ellipse cx="28" cy="21" rx="10" ry="7" fill="url(#visor-grad)" opacity="0.15" />

      <g filter="url(#glow-f)">
        <ChibiEyes mood={mood} accentColor={accentColor} />
      </g>

      <ChibiMouth mood={mood} />

      <circle cx="15" cy="22" r="2.5" fill="#334155" stroke="#475569" strokeWidth="0.5" />
      <circle cx="15" cy="22" r="1" fill={accentColor} opacity="0.6" />
      <circle cx="41" cy="22" r="2.5" fill="#334155" stroke="#475569" strokeWidth="0.5" />
      <circle cx="41" cy="22" r="1" fill={accentColor} opacity="0.6" />

      <path d="M22 35 L18 36 Q16 42 17 48 L20 48 Q19 43 21 38Z" fill="#334155" />
      <circle cx="17" cy="48" r="2" fill="#475569" />
      <circle cx="17" cy="48" r="1" fill={accentColor} opacity="0.4" />
      <path d="M34 35 L38 36 Q40 42 39 48 L36 48 Q37 43 35 38Z" fill="#334155" />
      <circle cx="39" cy="48" r="2" fill="#475569" />
      <circle cx="39" cy="48" r="1" fill={accentColor} opacity="0.4" />

      <path d="M22 34 Q28 38 34 34 L34 44 Q28 48 22 44Z" fill="#334155" />
      <path d="M25 37 L28 42 L31 37" fill="none" stroke={accentColor} strokeWidth="1" strokeLinecap="round" opacity="0.7" />
      <line x1="24" y1="40" x2="32" y2="40" stroke={accentColor} strokeWidth="0.5" opacity="0.3" />
      <line x1="24" y1="42" x2="32" y2="42" stroke={accentColor} strokeWidth="0.5" opacity="0.3" />

      <ChibiAccessories mood={mood} accentColor={accentColor} />
    </svg>
  );
}

export default function GuardianAvatar() {
  const mood = useGuardianStore((s) => s.mood);
  const thoughts = useGuardianStore((s) => s.thoughts);
  const isExpanded = useGuardianStore((s) => s.isExpanded);
  const initialize = useGuardianStore((s) => s.initialize);
  const toggleExpanded = useGuardianStore((s) => s.toggleExpanded);

  const setAvatarPosition = useGuardianStore((s) => s.setAvatarPosition);
  const [position, setPosition] = useState<Position>(loadPosition);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
    moved: false,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    initialize().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [initialize]);

  useEffect(() => {
    setAvatarPosition(position);
  }, [position, setAvatarPosition]);

  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => clampPosition(prev));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const drag = dragRef.current;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.startPosX = position.x;
    drag.startPosY = position.y;
    drag.moved = false;
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    const drag = dragRef.current;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    const next = clampPosition({
      x: drag.startPosX + dx,
      y: drag.startPosY + dy,
    });
    setPosition(next);
  }, [isDragging]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (dragRef.current.moved) {
      savePosition(position);
    } else {
      toggleExpanded();
    }
  }, [isDragging, position, toggleExpanded]);

  const undismissedCount = useMemo(
    () => thoughts.filter((t) => !t.dismissed).length,
    [thoughts],
  );

  const particles = useMemo(() => buildParticles(mood), [mood]);
  const colors = MOOD_COLORS[mood];
  const glowSpeed = MOOD_GLOW_SPEED[mood];
  const accentColor = MOOD_ACCENT[mood];
  const isCelebratory = mood === 'CELEBRATORY';

  useEffect(() => {
    console.log('[GuardianAvatar] Rendered — isExpanded:', isExpanded, 'position:', position);
  }, [isExpanded, position]);

  if (isExpanded) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      <div
        ref={containerRef}
        role="region"
        aria-label="Chitti the Trader"
        style={{
          position: 'fixed',
          left: position.x,
          top: position.y,
          zIndex: 9999,
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {particles.map((p, i) => (
            <span
              key={i}
              className="absolute rounded-full"
              style={{
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                '--start-angle': `${p.angle}deg`,
                '--radius': `${p.radius}px`,
                '--p-opacity': p.opacity,
                animation: isCelebratory
                  ? `guardian-sparkle ${p.duration * 0.6}s ease-in-out ${p.delay}s infinite, guardian-orbit ${p.duration}s linear ${p.delay}s infinite`
                  : `guardian-orbit ${p.duration}s linear ${p.delay}s infinite`,
              } as React.CSSProperties}
            />
          ))}
        </div>

        <div
          className="absolute -inset-1.5 rounded-full"
          style={{
            boxShadow: colors.glow,
            animation: `guardian-glow-pulse ${glowSpeed}s ease-in-out infinite`,
          }}
        />

        <div
          className="relative flex items-center justify-center w-14 h-14 rounded-full border border-white/10 shadow-lg backdrop-blur-sm transition-shadow duration-300 hover:shadow-xl overflow-visible"
          style={{
            background: colors.bg,
            animation: isDragging ? 'none' : 'guardian-breathe 3s ease-in-out infinite',
          }}
          aria-label={`Chitti the Trader · mood: ${mood.toLowerCase()}`}
        >
          <ChibiTrader mood={mood} accentColor={accentColor} />

          {undismissedCount > 0 && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold ring-2 ring-black/30 shadow">
              {undismissedCount > 9 ? '9+' : undismissedCount}
            </span>
          )}
        </div>

        <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-2 py-0.5 text-[10px] font-medium text-white/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          chitti &middot; {mood.toLowerCase()}
        </span>
      </div>
    </>
  );
}
