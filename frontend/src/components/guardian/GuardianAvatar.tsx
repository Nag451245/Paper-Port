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
          <path d="M19 20 Q23 16 27 20" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M29 20 Q33 16 37 20" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </>
      );
    case 'ALERT':
      return (
        <>
          <circle cx="23" cy="19" r="3.5" fill="white" />
          <circle cx="23" cy="19" r="2" fill={accentColor} />
          <circle cx="23" cy="18.2" r="1" fill="#1e293b" />
          <circle cx="24" cy="17.5" r="0.5" fill="white" />
          <circle cx="33" cy="19" r="3.5" fill="white" />
          <circle cx="33" cy="19" r="2" fill={accentColor} />
          <circle cx="33" cy="18.2" r="1" fill="#1e293b" />
          <circle cx="34" cy="17.5" r="0.5" fill="white" />
        </>
      );
    case 'FOCUSED':
      return (
        <>
          <path d="M19 21 Q23 17 27 20" stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M29 20 Q33 17 37 21" stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </>
      );
    case 'CAUTIOUS':
      return (
        <>
          <path d="M20 18 Q23 22 26 18" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M30 18 Q33 22 36 18" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </>
      );
    case 'CELEBRATORY':
      return (
        <>
          <path d="M19 20 Q23 16 27 20" stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M29 20 Q33 16 37 20" stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </>
      );
    case 'REFLECTIVE':
      return (
        <>
          <circle cx="23" cy="19" r="3" fill="white" />
          <circle cx="23" cy="20.5" r="1.8" fill={accentColor} />
          <circle cx="23" cy="21" r="0.8" fill="#1e293b" />
          <circle cx="33" cy="19" r="3" fill="white" />
          <circle cx="33" cy="20.5" r="1.8" fill={accentColor} />
          <circle cx="33" cy="21" r="0.8" fill="#1e293b" />
        </>
      );
    case 'VIGILANT':
      return (
        <>
          <path d="M20 21 L23 18 L26 21" stroke="#1e293b" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M30 21 L33 18 L36 21" stroke="#1e293b" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'CONTEMPLATIVE':
      return (
        <>
          <circle cx="23" cy="20" r="3" fill="white" />
          <circle cx="23" cy="20" r="1.8" fill={accentColor} />
          <circle cx="23" cy="20" r="0.7" fill="#1e293b" />
          <path d="M19.5 18 Q23 16 26.5 18 L26.5 19.5 Q23 17.5 19.5 19.5Z" fill="#fcd9b6" />
          <circle cx="33" cy="20" r="3" fill="white" />
          <circle cx="33" cy="20" r="1.8" fill={accentColor} />
          <circle cx="33" cy="20" r="0.7" fill="#1e293b" />
          <path d="M29.5 18 Q33 16 36.5 18 L36.5 19.5 Q33 17.5 29.5 19.5Z" fill="#fcd9b6" />
        </>
      );
  }
}

function ChibiMouth({ mood }: { mood: GuardianMood }) {
  switch (mood) {
    case 'COMPOSED':
      return <path d="M24 26 Q28 29 32 26" stroke="#1e293b" strokeWidth="1.2" fill="none" strokeLinecap="round" />;
    case 'ALERT':
      return <ellipse cx="28" cy="27" rx="2" ry="1.5" fill="#1e293b" />;
    case 'FOCUSED':
      return <line x1="25" y1="26" x2="31" y2="26" stroke="#1e293b" strokeWidth="1.5" strokeLinecap="round" />;
    case 'CAUTIOUS':
      return <path d="M23 27 Q25.5 29 28 27 Q30.5 25 33 27" stroke="#1e293b" strokeWidth="1.2" fill="none" strokeLinecap="round" />;
    case 'CELEBRATORY':
      return (
        <>
          <path d="M22 25 Q28 32 34 25" stroke="#1e293b" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M23 26 Q28 30 33 26" fill="white" opacity="0.8" />
        </>
      );
    case 'REFLECTIVE':
      return <path d="M25 27 Q28 29 31 27" stroke="#1e293b" strokeWidth="1" fill="none" strokeLinecap="round" />;
    case 'VIGILANT':
      return <line x1="24" y1="26" x2="32" y2="26" stroke="#1e293b" strokeWidth="1.5" strokeLinecap="round" />;
    case 'CONTEMPLATIVE':
      return <path d="M25 27 Q28 29 31 27" stroke="#1e293b" strokeWidth="1" fill="none" strokeLinecap="round" />;
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
  const isReflective = mood === 'REFLECTIVE';

  return (
    <svg viewBox="0 0 56 56" className="w-full h-full" style={{ overflow: 'visible' }}>
      <ellipse cx="28" cy="12" rx="13" ry="7" fill="#4a3728" />

      <circle cx="16" cy="21" r="2.5" fill="#fcd9b6" />
      <circle cx="40" cy="21" r="2.5" fill="#fcd9b6" />

      <circle cx="28" cy="20" r="11" fill="#fcd9b6" />

      <path d="M16 18 Q18 10 23 11 Q20 14 21 17Z" fill="#4a3728" />
      <path d="M23 11 Q28 7 33 11 Q28 10 23 11Z" fill="#4a3728" />
      <path d="M33 11 Q38 10 40 18 Q39 14 37 12 Q35 13 33 11Z" fill="#4a3728" />

      <circle cx="18" cy="23" r="2.5" fill="#f9a8d4" opacity="0.3" />
      <circle cx="38" cy="23" r="2.5" fill="#f9a8d4" opacity="0.3" />

      <ChibiEyes mood={mood} accentColor={accentColor} />

      <path d="M27 23 Q28 24.5 29 23" stroke="#d4a574" strokeWidth="0.8" fill="none" strokeLinecap="round" />

      <ChibiMouth mood={mood} />

      <rect x="25" y="30" width="6" height="4" rx="2" fill="#fcd9b6" />

      <path d="M19 33 L15 52 L41 52 L37 33 Q28 37 19 33Z" fill="#1e293b" />

      <path d="M24 33 L28 40 L32 33" fill="#e2e8f0" />

      <path d="M24 33 L27 39 L25 39 L21.5 34Z" fill={accentColor} opacity="0.5" />
      <path d="M32 33 L29 39 L31 39 L34.5 34Z" fill={accentColor} opacity="0.5" />

      <path d="M27.2 35 L28.8 35 L28.5 36.5 L27.5 36.5Z" fill={accentColor} />
      <path
        d="M27.5 36.5 L28.5 36.5 L29 44 L27 44Z"
        fill={accentColor}
        opacity="0.85"
        transform="rotate(3,28,40)"
      />

      {isReflective ? (
        <>
          <path d="M19 35 Q13 42 12 48" stroke="#1e293b" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="12" cy="48" r="2.2" fill="#fcd9b6" />
          <path d="M37 35 Q40 30 35 27" stroke="#1e293b" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="35" cy="27" r="2.2" fill="#fcd9b6" />
        </>
      ) : (
        <>
          <path d="M19 35 Q13 42 12 48" stroke="#1e293b" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="12" cy="48" r="2.2" fill="#fcd9b6" />
          <path d="M37 35 Q43 42 44 48" stroke="#1e293b" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="44" cy="48" r="2.2" fill="#fcd9b6" />
        </>
      )}

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
