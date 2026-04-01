const TZ = 'Asia/Kolkata';
/** Returns YYYY-MM-DD in IST for the given date (defaults to now). */
export function istDateStr(d = new Date()) {
    return d.toLocaleDateString('en-CA', { timeZone: TZ });
}
/** Returns a Date object set to midnight IST today. */
export function istMidnight(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return new Date(`${y}-${m}-${day}T00:00:00+05:30`);
}
/** Returns YYYY-MM-DD in IST for N days ago. */
export function istDaysAgo(days) {
    return istDateStr(new Date(Date.now() - days * 86_400_000));
}
//# sourceMappingURL=ist.js.map