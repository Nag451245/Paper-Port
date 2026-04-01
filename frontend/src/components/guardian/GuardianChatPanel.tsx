import { useState, useRef, useEffect, type KeyboardEvent, type FormEvent } from 'react';
import { X, Send } from 'lucide-react';
import { useGuardianStore, type GuardianMood, type ChatMessage } from '@/stores/guardian';

const MOOD_COLORS: Record<GuardianMood, string> = {
  COMPOSED: '#14b8a6',
  ALERT: '#f59e0b',
  FOCUSED: '#3b82f6',
  CAUTIOUS: '#f97316',
  CELEBRATORY: '#a855f7',
  REFLECTIVE: '#6366f1',
  VIGILANT: '#ef4444',
  CONTEMPLATIVE: '#8b5cf6',
};

const MOOD_LABELS: Record<GuardianMood, string> = {
  COMPOSED: 'Composed',
  ALERT: 'Alert',
  FOCUSED: 'Focused',
  CAUTIOUS: 'Cautious',
  CELEBRATORY: 'Celebratory',
  REFLECTIVE: 'Reflective',
  VIGILANT: 'Vigilant',
  CONTEMPLATIVE: 'Contemplative',
};

const CONTEXT_SUGGESTIONS: Record<string, string[]> = {
  dashboard: ["How's my portfolio?", 'Morning briefing', 'Market outlook'],
  terminal: ['Analyze this setup', "What's the risk?", 'Should I take this trade?'],
  'risk-dashboard': ['Assess my exposure', 'Any red flags?', 'Stress test'],
  'ai-agent': ['How are bots performing?', 'Signal quality?', 'Override recommendations'],
  portfolio: ['Portfolio health check', 'Optimize allocation', 'Sector concentration'],
  'option-chain': ['IV analysis', 'Best strategy for this?', 'PCR reading'],
  'strategy-builder': ['Validate this strategy', 'Backtest outlook'],
  learning: ['What did we learn?', 'Regime assessment'],
};
const DEFAULT_SUGGESTIONS = ['What should I watch?', 'Market outlook', 'Scan for setups'];

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function ChibiEyes({ mood, moodColor }: { mood: GuardianMood; moodColor: string }) {
  switch (mood) {
    case 'COMPOSED':
      return (
        <>
          <circle cx="11.5" cy="14.5" r="1.25" fill={moodColor} />
          <circle cx="20.5" cy="14.5" r="1.25" fill={moodColor} />
        </>
      );
    case 'ALERT':
      return (
        <>
          <circle cx="11.5" cy="14.5" r="2.15" fill={moodColor} />
          <circle cx="20.5" cy="14.5" r="2.15" fill={moodColor} />
        </>
      );
    case 'FOCUSED':
      return (
        <>
          <ellipse cx="11.5" cy="14.5" rx="1.4" ry="2" fill={moodColor} />
          <ellipse cx="20.5" cy="14.5" rx="1.4" ry="2" fill={moodColor} />
        </>
      );
    case 'CAUTIOUS':
      return (
        <>
          <ellipse cx="11.5" cy="14.5" rx="2.2" ry="1.15" fill={moodColor} />
          <ellipse cx="20.5" cy="14.5" rx="2.2" ry="1.15" fill={moodColor} />
        </>
      );
    case 'CELEBRATORY':
      return (
        <>
          <path
            d="M 9 15.5 Q 11.5 12.5 14 15.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M 18 15.5 Q 20.5 12.5 23 15.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </>
      );
    case 'REFLECTIVE':
      return (
        <>
          <path
            d="M 9.5 14.5 Q 11.5 16.5 13.5 14.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M 18.5 14.5 Q 20.5 16.5 22.5 14.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      );
    case 'VIGILANT':
      return (
        <>
          <circle cx="11.5" cy="14.5" r="2.35" fill={moodColor} />
          <circle cx="20.5" cy="14.5" r="2.35" fill={moodColor} />
          <circle cx="11.5" cy="14.5" r="0.85" fill="#0f172a" />
          <circle cx="20.5" cy="14.5" r="0.85" fill="#0f172a" />
        </>
      );
    case 'CONTEMPLATIVE':
      return (
        <>
          <path
            d="M 9 14.5 A 2.5 1.8 0 0 1 14 14.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.35"
            strokeLinecap="round"
          />
          <path
            d="M 18 14.5 A 2.5 1.8 0 0 1 23 14.5"
            fill="none"
            stroke={moodColor}
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </>
      );
    default: {
      const _exhaustive: never = mood;
      return _exhaustive;
    }
  }
}

function MiniChibi({
  mood,
  moodColor,
  size = 'sm',
}: {
  mood: GuardianMood;
  moodColor: string;
  size?: 'sm' | 'lg';
}) {
  const isLg = size === 'lg';
  const containerClass = isLg ? 'w-14 h-14' : 'w-9 h-9';
  const svgClass = isLg ? 'w-11 h-11' : 'w-7 h-7';
  const glowStyle = isLg
    ? { backgroundColor: `${moodColor}15`, boxShadow: `0 0 20px ${moodColor}35, inset 0 0 8px ${moodColor}10` }
    : { backgroundColor: `${moodColor}18`, boxShadow: `0 0 12px ${moodColor}40` };

  return (
    <div
      className={`rounded-full flex items-center justify-center shrink-0 ${containerClass}`}
      style={{ ...glowStyle, border: `1px solid ${moodColor}30` }}
    >
      <svg
        className={svgClass}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <rect x="14.5" y="1" width="3" height="4" rx="1.5" fill="#475569" />
        <circle cx="16" cy="1.5" r="1.5" fill={moodColor} opacity="0.8" />
        <circle cx="16" cy="16" r="10" fill="#1e293b" />
        <circle cx="16" cy="16" r="9" fill="#0f172a" stroke="#334155" strokeWidth="0.5" />
        <ChibiEyes mood={mood} moodColor={moodColor} />
        <path d="M13 20 Q16 22 19 20" stroke={moodColor} strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.6" />
        <circle cx="6.5" cy="16" r="1.5" fill="#334155" />
        <circle cx="6.5" cy="16" r="0.6" fill={moodColor} opacity="0.5" />
        <circle cx="25.5" cy="16" r="1.5" fill="#334155" />
        <circle cx="25.5" cy="16" r="0.6" fill={moodColor} opacity="0.5" />
      </svg>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isGuardian = msg.role === 'guardian';

  return (
    <div className={`flex ${isGuardian ? 'justify-start' : 'justify-end'}`}>
      <div style={{ maxWidth: '82%' }}>
        <p className={`text-[10px] font-medium mb-1 tracking-wide uppercase ${isGuardian ? 'text-teal-400/70' : 'text-cyan-300/70 text-right'}`}>
          {isGuardian ? 'Chitti' : 'You'}
        </p>
        <div
          className={
            isGuardian
              ? 'bg-gradient-to-br from-slate-800 to-slate-800/80 text-slate-100 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed border border-slate-700/50'
              : 'bg-gradient-to-br from-teal-600 to-teal-700 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed shadow-lg shadow-teal-900/20'
          }
        >
          {msg.content}
        </div>
        <p className={`text-[10px] text-slate-500/70 mt-1 ${isGuardian ? '' : 'text-right'}`}>
          {formatTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ maxWidth: '85%' }}>
      <p className="text-xs text-teal-400 mb-0.5">Chitti</p>
      <div className="bg-slate-800 rounded-xl rounded-tl-none px-4 py-3 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 rounded-full bg-teal-400 animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
    </div>
  );
}

export default function GuardianChatPanel() {
  const {
    mood,
    isExpanded,
    messages,
    isTyping,
    pageContext,
    sendMessage,
    setExpanded,
  } = useGuardianStore();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const moodColor = MOOD_COLORS[mood];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (isExpanded) {
      inputRef.current?.focus();
    }
  }, [isExpanded]);

  const handleSend = async (text?: string) => {
    const value = (text ?? input).trim();
    if (!value || isTyping) return;
    setInput('');
    await sendMessage(value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleSend();
  };

  const suggestions = CONTEXT_SUGGESTIONS[pageContext] ?? DEFAULT_SUGGESTIONS;
  const showSuggestions = messages.length < 3;
  const isEmpty = messages.length === 0 && !isTyping;
  const canSend = input.trim().length > 0 && !isTyping;

  return (
    <div
      className={`fixed z-50 flex flex-col rounded-2xl overflow-hidden
        bottom-20 right-4 sm:bottom-6 sm:right-6
        transition-all duration-300 ease-out
        ${isExpanded ? 'scale-100 opacity-100' : 'scale-90 opacity-0 pointer-events-none'}`}
      style={{
        width: 390,
        maxHeight: 620,
        backgroundColor: '#0b1120',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: `${moodColor}40`,
        boxShadow: `0 0 30px ${moodColor}18, 0 0 60px ${moodColor}08, 0 25px 50px -12px rgba(0,0,0,0.6)`,
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-3.5"
        style={{
          background: `linear-gradient(135deg, ${moodColor}12 0%, transparent 60%)`,
          borderBottom: `1px solid ${moodColor}25`,
        }}
      >
        <MiniChibi mood={mood} moodColor={moodColor} size="sm" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-bold tracking-[0.15em] text-white/90">CHITTI</p>
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: moodColor }}
            />
          </div>
          <p className="text-[11px] text-slate-400">
            AI Trading Companion · <span style={{ color: moodColor }}>{MOOD_LABELS[mood]}</span>
          </p>
        </div>

        <button
          onClick={() => setExpanded(false)}
          className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      <div
        className="h-px w-full"
        style={{ background: `linear-gradient(90deg, transparent, ${moodColor}60, transparent)` }}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4" style={{ minHeight: 220 }}>
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-4 py-12">
            <MiniChibi mood={mood} moodColor={moodColor} size="lg" />
            <div className="text-center max-w-[260px]">
              <p className="text-white/80 font-medium text-sm mb-1">Ready to assist</p>
              <p className="text-slate-500 text-xs leading-relaxed">
                I monitor every trade, signal, and risk metric in real-time. Ask me anything about your portfolio.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {isTyping && <TypingIndicator />}
      </div>

      {showSuggestions && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {suggestions.map((text) => (
            <button
              key={text}
              onClick={() => void handleSend(text)}
              className="text-xs px-3 py-1.5 rounded-full transition-all duration-200 hover:scale-105"
              style={{
                backgroundColor: `${moodColor}12`,
                color: `${moodColor}`,
                border: `1px solid ${moodColor}25`,
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-3 border-t backdrop-blur-sm"
        style={{
          borderColor: `${moodColor}15`,
          background: 'linear-gradient(180deg, #0f172a 0%, #0b1120 100%)',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Chitti..."
          className="flex-1 bg-slate-800/80 text-white placeholder-slate-500 rounded-xl px-4 py-2.5 text-sm outline-none transition-all duration-200"
          style={{
            border: `1px solid ${moodColor}20`,
            boxShadow: input.trim() ? `0 0 8px ${moodColor}15` : 'none',
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          style={{
            background: canSend ? `linear-gradient(135deg, ${moodColor}, ${moodColor}cc)` : '#1e293b',
            boxShadow: canSend ? `0 4px 12px ${moodColor}30` : 'none',
          }}
        >
          <Send className="w-4 h-4 text-white" />
        </button>
      </form>
    </div>
  );
}
