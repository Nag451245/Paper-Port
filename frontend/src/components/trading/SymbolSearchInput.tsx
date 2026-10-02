import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { marketApi } from '@/services/api';

interface Result { symbol: string; name: string; exchange: string }

/**
 * A symbol box that suggests matching stocks as you type, like the Trading
 * Terminal's search. Typing changes the value; picking a suggestion (click,
 * or arrows + Enter) sets it to that symbol.
 */
export default function SymbolSearchInput({ value, onChange, exchange = 'NSE', placeholder, className = '', extra = [] }: {
  value: string;
  onChange: (symbol: string) => void;
  exchange?: string;
  placeholder?: string;
  className?: string;
  /** Always-available suggestions (e.g. F&O indices) listed first when they match what is typed. */
  extra?: Result[];
}) {
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef(false);                        // only search what the user typed

  useEffect(() => {
    const q = value.trim();
    if (!typed.current || !q) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await marketApi.search(q, exchange);
        if (stale) return;
        const found = Array.isArray(data) ? data : [];
        const pinned = extra.filter((e) => e.symbol.includes(q) || e.name.toUpperCase().includes(q));
        const list = [...pinned, ...found.filter((r) => !pinned.some((p) => p.symbol === r.symbol))].slice(0, 12);
        setResults(list);
        setActive(-1);
        setOpen(list.length > 0);
      } catch { if (!stale) setResults([]); }
    }, 250);
    return () => { stale = true; clearTimeout(t); };
    // `extra` is a constant list at each call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, exchange]);

  const pick = (r: Result) => {
    typed.current = false;
    onChange(r.symbol);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
      <input
        value={value}
        placeholder={placeholder ?? 'Type to search, e.g. REL'}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          typed.current = true;
          const v = e.target.value.toUpperCase();
          onChange(v);
          if (!v.trim()) { setResults([]); setOpen(false); }
        }}
        onFocus={() => { if (results.length) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open || !results.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? results.length - 1 : i - 1)); }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(results[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
        className={className}
        style={{ paddingLeft: '2rem' }}            // room for the search icon
      />
      {open && (
        <ul role="listbox" className="absolute top-full left-0 mt-1 w-full min-w-[16rem] max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-xl z-50">
          {results.map((r, i) => (
            <li key={`${r.symbol}-${r.exchange}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                // mousedown, so the pick lands before the input's blur closes the list
                onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left ${i === active ? 'bg-indigo-50' : 'hover:bg-indigo-50'}`}
              >
                <span className="min-w-0">
                  <span className="font-semibold text-xs text-slate-800">{r.symbol}</span>
                  <span className="ml-2 text-[11px] text-slate-400 truncate">{r.name}</span>
                </span>
                <span className="shrink-0 text-[10px] text-slate-400">{r.exchange}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
