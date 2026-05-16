import Alert from '../models/Alert.model';
import Signal from '../models/Signal.model';
import { getOHLCV } from './chart.service';
import { computeAll } from './indicator.service';

export async function checkAlerts(): Promise<void> {
  try {
    const alerts = await Alert.find({ enabled: true, triggered: false });

    for (const alert of alerts) {
      try {
        const triggered = await evaluateAlert(alert);

        if (triggered) {
          alert.triggered = true;
          alert.triggeredAt = new Date();
          await alert.save();
          console.log(`✓ Alert triggered: ${alert.pair} - ${alert.condition}`);
        }
      } catch (error) {
        console.error(`Error evaluating alert ${alert._id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error checking alerts:', error);
  }
}

async function evaluateAlert(alert: any): Promise<boolean> {
  const { condition, targetValue, targetPattern, pair } = alert;
  const tf = alert.timeframe || '1h';

  try {
    if (condition.startsWith('price_')) {
      const candles = await getOHLCV(pair, '1h');
      if (candles.length === 0) return false;

      const latestPrice = candles[candles.length - 1].close;

      if (condition === 'price_above') return latestPrice > targetValue;
      if (condition === 'price_below') return latestPrice < targetValue;
    }

    if (condition.startsWith('rsi_')) {
      const candles = await getOHLCV(pair, tf);
      if (candles.length === 0) return false;

      const { rsi } = computeAll(candles);

      if (condition === 'rsi_above') return rsi > targetValue;
      if (condition === 'rsi_below') return rsi < targetValue;
    }

    if (condition.startsWith('ai_signal_')) {
      // Use most recent cached signal from DB (avoids expensive Groq call on every check)
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const recent = await Signal.findOne({
        userId:    alert.userId,
        pair,
        timeframe: tf,
        createdAt: { $gte: new Date(Date.now() - TWO_HOURS) },
      }).sort({ createdAt: -1 }).lean();

      if (!recent) return false;

      if (condition === 'ai_signal_buy') {
        return recent.signal === 'BUY' && recent.confidence > (targetValue ?? 50);
      }
      if (condition === 'ai_signal_sell') {
        return recent.signal === 'SELL' && recent.confidence > (targetValue ?? 50);
      }
    }

    if (condition === 'pattern_detected') {
      const candles = await getOHLCV(pair, tf);
      if (candles.length === 0) return false;

      const { patterns } = computeAll(candles);
      return patterns.includes(targetPattern);
    }

    return false;
  } catch (error) {
    console.error(`Error evaluating condition ${condition}:`, error);
    return false;
  }
}
