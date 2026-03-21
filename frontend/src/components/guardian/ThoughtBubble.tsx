import { useEffect, useCallback } from 'react';
import { X, AlertTriangle, Lightbulb, Eye } from 'lucide-react';
import { useGuardianStore, type GuardianThought, type GuardianMood } from '@/stores/guardian';

const PRIORITY_STYLES: Record<GuardianThought['priority'], string> = {
  low: 'border-slate-600/50 bg-slate-800/95',
  medium: 'border-amber-500/40 bg-slate-800/95',
  high: 'border-red-400/50 bg-slate-900/95',
};

const CATEGORY_ICONS: Record<GuardianThought['category'], typeof Eye> = {
  observation: Eye,
  alert: AlertTriangle,
  opinion: Lightbulb,
  greeting: Eye,
  insight: Lightbulb,
};

const MOOD_ACCENT: Record<GuardianMood, string> = {
  COMPOSED: 'text-teal-400',
  ALERT: 'text-amber-400',
  FOCUSED: 'text-cyan-400',
  CAUTIOUS: 'text-red-400',
  CELEBRATORY: 'text-emerald-400',
  REFLECTIVE: 'text-purple-400',
  VIGILANT: 'text-blue-400',
  CONTEMPLATIVE: 'text-indigo-400',
};

const AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE = 2;

export default function ThoughtBubble() {
  const thoughts = useGuardianStore((s) => s.thoughts);
  const isExpanded = useGuardianStore((s) => s.isExpanded);
  const dismissThought = useGuardianStore((s) => s.dismissThought);
  const toggleExpanded = useGuardianStore((s) => s.toggleExpanded);

  const visible = thoughts
    .filter((t) => !t.dismissed)
    .slice(-MAX_VISIBLE);

  const autoDismiss = useCallback(
    (id: string, priority: string) => {
      if (priority === 'high') return;
      const timer = setTimeout(() => dismissThought(id), AUTO_DISMISS_MS);
      return timer;
    },
    [dismissThought],
  );

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const t of visible) {
      const timer = autoDismiss(t.id, t.priority);
      if (timer) timers.push(timer);
    }
    return () => timers.forEach(clearTimeout);
  }, [visible, autoDismiss]);

  if (isExpanded || visible.length === 0) return null;

  return (
    <div className="fixed bottom-36 right-4 z-50 md:bottom-22 md:right-6 flex flex-col gap-2 items-end pointer-events-none">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes thought-slide-in {
          0% { opacity: 0; transform: translateY(8px) scale(0.95); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}} />
      {visible.map((thought) => {
        const Icon = CATEGORY_ICONS[thought.category];
        const accent = MOOD_ACCENT[thought.mood];
        return (
          <div
            key={thought.id}
            className={`pointer-events-auto max-w-72 rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur-sm ${PRIORITY_STYLES[thought.priority]}`}
            style={{ animation: 'thought-slide-in 300ms ease-out forwards' }}
          >
            <div className="flex items-start gap-2">
              <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${accent}`} />
              <p
                className="text-xs text-slate-200 leading-relaxed flex-1 cursor-pointer"
                onClick={() => {
                  dismissThought(thought.id);
                  toggleExpanded();
                }}
              >
                {thought.content}
              </p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismissThought(thought.id);
                }}
                className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
              >
                <X className="w-3 h-3 text-slate-500" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
