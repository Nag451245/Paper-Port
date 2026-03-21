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
  const containerClass = isLg ? 'w-12 h-12' : 'w-8 h-8';
  const svgClass = isLg ? 'w-10 h-10' : 'w-[26px] h-[26px]';
  const glowStyle = isLg
    ? { backgroundColor: `${moodColor}15`, boxShadow: `0 0 16px ${moodColor}30` }
    : { backgroundColor: `${moodColor}20`, boxShadow: `0 0 10px ${moodColor}40` };

  return (
    <div
      className={`rounded-full flex items-center justify-center shrink-0 ${containerClass}`}
      style={glowStyle}
    >
      <svg
        className={svgClass}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <path
          d="M 7 12 C 7 6 25 6 25 12 C 25 10 23 7 16 7 C 9 7 7 10 7 12 Z"
          fill="#4a3728"
        />
        <circle cx="16" cy="17" r="9" fill="#fcd9b6" />
        <ChibiEyes mood={mood} moodColor={moodColor} />
        <path
          d="M 13 20.5 Q 16 23 19 20.5"
          stroke="#4a3728"
          strokeWidth="1.1"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isGuardian = msg.role === 'guardian';

  return (
    <div className={isGuardian ? '' : 'ml-auto'} style={{ maxWidth: '85%' }}>
      <p className={`text-xs mb-0.5 ${isGuardian ? 'text-teal-400' : 'text-teal-300 text-right'}`}>
        {isGuardian ? 'Chitti' : 'You'}
      </p>
      <div
        className={
          isGuardian
            ? 'bg-slate-800 text-slate-100 rounded-xl rounded-tl-none px-3.5 py-2.5 text-sm leading-relaxed'
            : 'bg-teal-600 text-white rounded-xl rounded-tr-none px-3.5 py-2.5 text-sm leading-relaxed'
        }
      >
        {msg.content}
      </div>
      <p className={`text-xs text-slate-500 mt-1 ${isGuardian ? '' : 'text-right'}`}>
        {formatTime(msg.timestamp)}
      </p>
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
      className={`fixed z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden
        bottom-20 right-4 sm:bottom-6 sm:right-6
        transition-all duration-200 ease-out
        ${isExpanded ? 'scale-100 opacity-100' : 'scale-95 opacity-0 pointer-events-none'}`}
      style={{
        width: 380,
        maxHeight: 600,
        backgroundColor: '#0f172a',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: moodColor,
        boxShadow: `0 0 20px ${moodColor}22, 0 25px 50px -12px rgba(0,0,0,0.5)`,
      }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3">
        <MiniChibi mood={mood} moodColor={moodColor} size="sm" />

        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-sm font-bold tracking-widest text-white/90">CHITTI</p>
          <p className="text-xs" style={{ color: moodColor }}>
            The Trader · {MOOD_LABELS[mood]}
          </p>
        </div>

        <button
          onClick={() => setExpanded(false)}
          className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Mood Strip */}
      <div className="h-0.5 w-full" style={{ backgroundColor: moodColor }} />

      {/* Chat Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3" style={{ minHeight: 200 }}>
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full gap-3 py-10">
            <MiniChibi mood={mood} moodColor={moodColor} size="lg" />
            <p className="text-slate-400 italic text-sm text-center max-w-[250px] leading-relaxed">
              I am Chitti. I see everything this platform sees — every trade, every signal, every risk. Ask me
              anything.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {isTyping && <TypingIndicator />}
      </div>

      {/* Context Suggestions */}
      {showSuggestions && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {suggestions.map((text) => (
            <button
              key={text}
              onClick={() => void handleSend(text)}
              className="bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 px-3 py-1 rounded-full transition-colors"
            >
              {text}
            </button>
          ))}
        </div>
      )}

      {/* Input Area */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-2.5 border-t border-slate-700 bg-slate-800/80 backdrop-blur-sm"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Chitti..."
          className="flex-1 bg-slate-700 text-white placeholder-slate-400 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-teal-500/50"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="w-10 h-10 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shrink-0"
        >
          <Send className="w-4 h-4 text-white" />
        </button>
      </form>
    </div>
  );
}
