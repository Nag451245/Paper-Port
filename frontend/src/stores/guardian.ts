import { create } from 'zustand';
import api from '@/services/api';
import { liveSocket } from '@/services/websocket';

export type GuardianMood =
  | 'COMPOSED'
  | 'ALERT'
  | 'FOCUSED'
  | 'CAUTIOUS'
  | 'CELEBRATORY'
  | 'REFLECTIVE'
  | 'VIGILANT'
  | 'CONTEMPLATIVE';

export interface GuardianThought {
  id: string;
  content: string;
  mood: GuardianMood;
  category: 'observation' | 'alert' | 'opinion' | 'greeting' | 'insight';
  priority: 'low' | 'medium' | 'high';
  timestamp: string;
  dismissed: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'guardian';
  content: string;
  mood?: GuardianMood;
  timestamp: string;
}

const GUARDIAN_MOODS: readonly GuardianMood[] = [
  'COMPOSED',
  'ALERT',
  'FOCUSED',
  'CAUTIOUS',
  'CELEBRATORY',
  'REFLECTIVE',
  'VIGILANT',
  'CONTEMPLATIVE',
] as const;

const MOOD_SET = new Set<string>(GUARDIAN_MOODS);

function parseMood(value: unknown): GuardianMood {
  if (typeof value === 'string' && MOOD_SET.has(value)) {
    return value as GuardianMood;
  }
  return 'COMPOSED';
}

function parseMoodIntensity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const n = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, n));
}

function parseCategory(value: unknown): GuardianThought['category'] {
  switch (value) {
    case 'observation':
    case 'alert':
    case 'opinion':
    case 'greeting':
    case 'insight':
      return value;
    default:
      return 'observation';
  }
}

function parsePriority(value: unknown): GuardianThought['priority'] {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return 'low';
  }
}

function newEntityId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
}

function thoughtIdFromEvent(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function pickPayload(msg: Record<string, unknown>): Record<string, unknown> {
  const nested = msg.payload ?? msg.data;
  if (nested !== undefined && nested !== null && typeof nested === 'object') {
    return asRecord(nested);
  }
  return msg;
}

function normalizeChatMessage(raw: unknown): ChatMessage | null {
  const o = asRecord(raw);
  const content = o.content ?? o.text ?? o.body;
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }
  const roleRaw = o.role ?? o.sender;
  const role =
    roleRaw === 'user' || roleRaw === 'guardian'
      ? roleRaw
      : roleRaw === 'assistant'
        ? 'guardian'
        : 'guardian';
  const id =
    typeof o.id === 'string' && o.id
      ? o.id
      : typeof o.message_id === 'string' && o.message_id
        ? o.message_id
        : newEntityId();
  const ts =
    typeof o.timestamp === 'string'
      ? o.timestamp
      : typeof o.created_at === 'string'
        ? o.created_at
        : new Date().toISOString();
  const moodRaw = o.mood;
  const mood = moodRaw !== undefined ? parseMood(moodRaw) : undefined;
  const msg: ChatMessage = {
    id,
    role,
    content: content.trim(),
    timestamp: ts,
  };
  if (mood !== undefined && mood !== 'COMPOSED') {
    msg.mood = mood;
  } else if (typeof moodRaw === 'string' && MOOD_SET.has(moodRaw)) {
    msg.mood = moodRaw as GuardianMood;
  }
  return msg;
}

function applyStatePayload(
  raw: Record<string, unknown>
): Partial<
  Pick<GuardianStore, 'mood' | 'moodIntensity' | 'lastThought' | 'messages'>
> {
  const patch: Partial<
    Pick<GuardianStore, 'mood' | 'moodIntensity' | 'lastThought' | 'messages'>
  > = {};

  if ('mood' in raw) {
    patch.mood = parseMood(raw.mood);
  }
  if (raw.moodIntensity !== undefined || raw.mood_intensity !== undefined) {
    const intensity = parseMoodIntensity(
      raw.moodIntensity ?? raw.mood_intensity
    );
    if (intensity !== undefined) {
      patch.moodIntensity = intensity;
    }
  }
  if ('lastThought' in raw || 'last_thought' in raw) {
    const lastRaw = raw.lastThought ?? raw.last_thought;
    patch.lastThought =
      lastRaw === null || lastRaw === undefined
        ? null
        : typeof lastRaw === 'string'
          ? lastRaw
          : String(lastRaw);
  }
  if (Array.isArray(raw.messages)) {
    patch.messages = raw.messages
      .map(normalizeChatMessage)
      .filter((m): m is ChatMessage => m !== null);
  }

  return patch;
}

/** Only the first expand-via-toggle with an empty transcript triggers an automatic greeting. */
let autoGreetingFromToggleSent = false;

export interface GuardianStore {
  mood: GuardianMood;
  moodIntensity: number;
  lastThought: string | null;
  thoughts: GuardianThought[];
  isExpanded: boolean;
  messages: ChatMessage[];
  isTyping: boolean;
  isInitialized: boolean;
  pageContext: string;

  initialize: () => Promise<() => void>;
  fetchState: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  toggleExpanded: () => void;
  setExpanded: (expanded: boolean) => void;
  dismissThought: (id: string) => void;
  acknowledgeThought: (id: string) => void;
  setPageContext: (page: string) => void;
  clearMessages: () => void;
}

export const useGuardianStore = create<GuardianStore>((set, get) => ({
  mood: 'COMPOSED',
  moodIntensity: 0.5,
  lastThought: null,
  thoughts: [],
  isExpanded: false,
  messages: [],
  isTyping: false,
  isInitialized: false,
  pageContext: '',

  initialize: async () => {
    try {
      await get().fetchState();
    } catch {
      /* fetchState is already defensive */
    }

    try {
      liveSocket.connect();
    } catch {
      /* optional transport */
    }

    const handler = (msg: unknown) => {
      try {
        const root = asRecord(msg);
        const payload = pickPayload(root);
        const content =
          typeof payload.content === 'string'
            ? payload.content
            : typeof payload.thought === 'string'
              ? payload.thought
              : typeof payload.message === 'string'
                ? payload.message
                : '';
        if (!content.trim()) {
          return;
        }

        const mood = parseMood(payload.mood ?? root.mood);
        const intensity =
          parseMoodIntensity(
            payload.moodIntensity ?? payload.mood_intensity ?? root.moodIntensity ?? root.mood_intensity
          );

        const thought: GuardianThought = {
          id: thoughtIdFromEvent(),
          content: content.trim(),
          mood,
          category: parseCategory(payload.category ?? payload.kind),
          priority: parsePriority(payload.priority),
          timestamp:
            typeof payload.timestamp === 'string'
              ? payload.timestamp
              : typeof payload.created_at === 'string'
                ? payload.created_at
                : new Date().toISOString(),
          dismissed: false,
        };

        set((s) => ({
          thoughts: [...s.thoughts, thought],
          mood,
          moodIntensity: intensity !== undefined ? intensity : s.moodIntensity,
        }));
      } catch {
        /* never throw from WS handler */
      }
    };

    let unsub: (() => void) | undefined;
    try {
      unsub = liveSocket.on('guardian_thought', handler);
    } catch {
      /* ignore */
    }

    set({ isInitialized: true });

    return () => {
      try {
        unsub?.();
      } catch {
        /* ignore */
      }
      set({ isInitialized: false });
    };
  },

  fetchState: async () => {
    try {
      const { data } = await api.get<unknown>('/guardian/state');
      const raw = asRecord(data);
      const patch = applyStatePayload(raw);
      set((s) => ({
        mood: patch.mood ?? s.mood,
        moodIntensity: patch.moodIntensity ?? s.moodIntensity,
        lastThought:
          patch.lastThought !== undefined ? patch.lastThought : s.lastThought,
        messages: patch.messages ?? s.messages,
      }));
    } catch {
      /* keep existing state */
    }
  },

  sendMessage: async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const userMessage: ChatMessage = {
      id: newEntityId(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    set((s) => ({
      messages: [...s.messages, userMessage],
      isTyping: true,
    }));

    try {
      const { data } = await api.post<unknown>('/guardian/chat', {
        message: trimmed,
        pageContext: get().pageContext,
      });
      const d = asRecord(data);
      const text = d.content ?? d.message ?? d.response ?? d.reply;
      const guardianContent = typeof text === 'string' ? text : text != null ? String(text) : '';
      const guardianMessage: ChatMessage = {
        id: newEntityId(),
        role: 'guardian',
        content: guardianContent,
        timestamp:
          typeof d.timestamp === 'string'
            ? d.timestamp
            : typeof d.created_at === 'string'
              ? d.created_at
              : new Date().toISOString(),
      };
      const gmood = parseMood(d.mood);
      guardianMessage.mood = gmood;
      const gIntensity = parseMoodIntensity(d.moodIntensity ?? d.mood_intensity);

      set((s) => ({
        messages: [...s.messages, guardianMessage],
        mood: gmood,
        moodIntensity: gIntensity !== undefined ? gIntensity : s.moodIntensity,
        isTyping: false,
      }));
    } catch {
      const fallback: ChatMessage = {
        id: newEntityId(),
        role: 'guardian',
        content: 'My connection wavered for a moment. Try again.',
        timestamp: new Date().toISOString(),
      };
      set((s) => ({
        messages: [...s.messages, fallback],
        isTyping: false,
      }));
    }
  },

  toggleExpanded: () => {
    const { isExpanded, messages, isTyping, sendMessage } = get();
    const next = !isExpanded;
    set({ isExpanded: next });
    if (
      next &&
      !autoGreetingFromToggleSent &&
      messages.length === 0 &&
      !isTyping
    ) {
      autoGreetingFromToggleSent = true;
      void sendMessage('Hello').catch(() => {
        /* sendMessage already handles errors internally */
      });
    }
  },

  setExpanded: (expanded: boolean) => {
    set({ isExpanded: expanded });
  },

  dismissThought: (id: string) => {
    if (!id) {
      return;
    }
    set((s) => ({
      thoughts: s.thoughts.map((t) =>
        t.id === id ? { ...t, dismissed: true } : t
      ),
    }));
  },

  acknowledgeThought: (id: string) => {
    if (!id) {
      return;
    }
    get().dismissThought(id);
    void api.post('/guardian/acknowledge', { thoughtId: id }).catch(() => {});
  },

  setPageContext: (page: string) => {
    set({ pageContext: page });
  },

  clearMessages: () => {
    set({ messages: [] });
  },
}));
