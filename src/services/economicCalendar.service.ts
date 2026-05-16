// Economic calendar — fetches high-impact forex events from ForexFactory (unofficial JSON feed).
// Events are cached for 1 hour. All functions fail-open so a dead feed never blocks signals.

import axios from 'axios';

export interface CalendarEvent {
  title:     string;
  country:   string;
  date:      string;   // ISO-8601 string
  impact:    'High' | 'Medium' | 'Low' | 'Holiday';
  forecast?: string;
  previous?: string;
}

// Country codes relevant to each supported pair
const PAIR_COUNTRIES: Record<string, string[]> = {
  'GBP/USD': ['GBP', 'USD'],
  'EUR/USD': ['EUR', 'USD'],
  'USD/JPY': ['USD', 'JPY'],
  'XAU/USD': ['USD'],        // gold moves on USD news (CPI, NFP, FOMC)
};

const FEED_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

let _cache: { events: CalendarEvent[]; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchCalendar(): Promise<CalendarEvent[]> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL) {
    return _cache.events;
  }

  const results = await Promise.allSettled(
    FEED_URLS.map((url) =>
      axios.get<CalendarEvent[]>(url, { timeout: 10_000 })
    ),
  );

  const events: CalendarEvent[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value.data)) {
      events.push(...r.value.data);
    }
  }

  if (events.length > 0) {
    _cache = { events, fetchedAt: Date.now() };
  }

  return events;
}

// Returns High-impact events for a pair within the next N minutes (or just passed by ≤5 min)
export async function getUpcomingHighImpactEvents(
  pair: string,
  withinMinutes = 60,
): Promise<CalendarEvent[]> {
  const events   = await fetchCalendar();
  const now      = Date.now();
  const cutoff   = now + withinMinutes * 60_000;
  const countries = new Set(PAIR_COUNTRIES[pair] ?? ['USD']);

  return events.filter((e) => {
    const t = new Date(e.date).getTime();
    return (
      e.impact === 'High' &&
      t >= now - 5 * 60_000 &&  // events that just fired (±5 min)
      t <= cutoff &&
      countries.has(e.country)
    );
  });
}

// Boolean helper — returns false on any error (fail-open)
export async function hasUpcomingHighImpactNews(
  pair: string,
  withinMinutes = 60,
): Promise<boolean> {
  try {
    const events = await getUpcomingHighImpactEvents(pair, withinMinutes);
    return events.length > 0;
  } catch {
    return false;
  }
}

// Returns all upcoming events for a pair (all impact levels), for display in UI
export async function getAllUpcomingEvents(
  pair: string,
  withinHours = 24,
): Promise<CalendarEvent[]> {
  try {
    const events    = await fetchCalendar();
    const now       = Date.now();
    const cutoff    = now + withinHours * 3_600_000;
    const countries = new Set(PAIR_COUNTRIES[pair] ?? ['USD']);

    return events
      .filter((e) => {
        const t = new Date(e.date).getTime();
        return t >= now && t <= cutoff && countries.has(e.country);
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  } catch {
    return [];
  }
}
