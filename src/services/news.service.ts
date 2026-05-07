import axios from 'axios';
import env from '../config/env';
import NewsCache from '../models/NewsCache.model';
import { INewsItem } from '../types/news.types';
import { scoreNewsSentiment } from './groq.service';
import { ValidPair } from '../types/chart.types';

export async function getNewsByPair(pair: ValidPair): Promise<INewsItem[]> {
  const cacheKey = `news:${pair}`;
  
  // Check cache
  const cached = await NewsCache.findOne({ key: cacheKey, expiresAt: { $gt: new Date() } });
  if (cached) {
    return cached.data as INewsItem[];
  }

  try {
    const symbol = pair.split('/')[0].toLowerCase();
    const response = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: symbol,
        sortBy: 'publishedAt',
        language: 'en',
        pageSize: 10,
        apiKey: env.newsApiKey,
      },
    });

    const articles = response.data.articles || [];
    const headlines = articles.map((a: any) => a.title);

    const sentiments = await scoreNewsSentiment(headlines, pair);

    const news: INewsItem[] = sentiments.map((sentiment: any, idx: number) => ({
      headline: sentiment.headline || articles[idx]?.title || '',
      sentiment: sentiment.sentiment || 'neut',
      impact: sentiment.impact || 'med',
      score: sentiment.score || 0,
      reasoning: sentiment.reasoning || '',
      source: articles[idx]?.source?.name || 'Unknown',
      publishedAt: new Date(articles[idx]?.publishedAt || new Date()),
      pairs: [pair],
    }));

    // Cache result (30 minutes)
    await NewsCache.create({
      key: cacheKey,
      data: news,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    return news;
  } catch (error) {
    console.error('Error fetching news:', error);
    return [];
  }
}

export async function getSentimentSummary(pair: ValidPair): Promise<string> {
  const news = await getNewsByPair(pair);
  
  if (news.length === 0) return 'No news available';

  const bullCount = news.filter((n) => n.sentiment === 'bull').length;
  const bearCount = news.filter((n) => n.sentiment === 'bear').length;
  const neutCount = news.filter((n) => n.sentiment === 'neut').length;
  const avgScore = news.reduce((sum, n) => sum + n.score, 0) / news.length;

  const bias = avgScore > 0 ? 'bullish' : avgScore < 0 ? 'bearish' : 'neutral';

  return `${bullCount} bullish, ${bearCount} bearish, ${neutCount} neutral — net ${bias} bias (${(avgScore).toFixed(2)})`;
}

// ─── Economic Calendar ────────────────────────────────────────────────────────
// Fetches this week + next week from the Forex Factory public JSON feed.
// Falls back to an empty array — never throws to callers.

const CALENDAR_CACHE_KEY = 'calendar:live';
const CALENDAR_TTL_MS    = 6 * 60 * 60 * 1000; // refresh every 6 hours

const COUNTRY_MAP: Record<string, string> = {
  USD: 'US', EUR: 'EU', GBP: 'UK', JPY: 'JP',
  AUD: 'AU', CAD: 'CA', CHF: 'CH', NZD: 'NZ',
  CNY: 'CN', XAU: 'US',
};

// Pairs we care about — only show events for these currencies
const WATCHED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'XAU']);

export async function getEconomicCalendar(): Promise<object[]> {
  // Check cache first
  const cached = await NewsCache.findOne({
    key: CALENDAR_CACHE_KEY,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (cached?.data && Array.isArray(cached.data)) return cached.data as object[];

  try {
    const [thisWeek, nextWeek] = await Promise.allSettled([
      axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { timeout: 10_000 }),
      axios.get('https://nfs.faireconomy.media/ff_calendar_nextweek.json', { timeout: 10_000 }),
    ]);

    const raw: any[] = [
      ...(thisWeek.status === 'fulfilled' ? thisWeek.value.data : []),
      ...(nextWeek.status === 'fulfilled' ? nextWeek.value.data : []),
    ];

    if (raw.length === 0) return getFallbackCalendar();

    const events = raw
      .filter((e: any) => {
        const impact   = (e.impact || '').toLowerCase();
        const currency = (e.country || '').toUpperCase();
        return (impact === 'high' || impact === 'medium') &&
               WATCHED_CURRENCIES.has(currency);
      })
      .map((e: any) => ({
        time:          e.date ?? '',
        title:         e.title ?? '',
        country:       COUNTRY_MAP[(e.country ?? '').toUpperCase()] ?? e.country,
        currency:      (e.country ?? '').toUpperCase(),
        impact:        (e.impact ?? 'low').toLowerCase(),
        previousValue: e.previous ?? '—',
        forecastValue: e.forecast ?? '—',
        actualValue:   e.actual   ?? null,
      }))
      .sort((a: any, b: any) => new Date(a.time).getTime() - new Date(b.time).getTime());

    // Cache for 6 hours
    await NewsCache.findOneAndUpdate(
      { key: CALENDAR_CACHE_KEY },
      { key: CALENDAR_CACHE_KEY, data: events, expiresAt: new Date(Date.now() + CALENDAR_TTL_MS) },
      { upsert: true },
    );

    return events;
  } catch (err) {
    console.warn('[calendar] Live fetch failed, using fallback:', (err as Error).message);
    return getFallbackCalendar();
  }
}

// Minimal fallback so UI never renders empty — lists recurring high-impact events
// with no specific dates (to indicate "check for upcoming")
function getFallbackCalendar(): object[] {
  return [
    { time: '', title: 'US Non-Farm Payrolls',        country: 'US', currency: 'USD', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'Fed Interest Rate Decision',  country: 'US', currency: 'USD', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'ECB Rate Decision',           country: 'EU', currency: 'EUR', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'BoE Rate Decision',           country: 'UK', currency: 'GBP', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'BoJ Rate Decision',           country: 'JP', currency: 'JPY', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'UK CPI (Inflation)',          country: 'UK', currency: 'GBP', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
    { time: '', title: 'US CPI (Inflation)',          country: 'US', currency: 'USD', impact: 'high', previousValue: '—', forecastValue: '—', actualValue: null },
  ];
}
