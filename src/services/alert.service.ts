import Alert from '../models/Alert.model';
import { getSignal } from './signal.service';
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

  try {
    if (condition.startsWith('price_')) {
      const candles = await getOHLCV(pair, '1h');
      if (candles.length === 0) return false;

      const latestPrice = candles[candles.length - 1].close;

      if (condition === 'price_above') return latestPrice > targetValue;
      if (condition === 'price_below') return latestPrice < targetValue;
    }

    if (condition.startsWith('rsi_')) {
      const candles = await getOHLCV(pair, '1h');
      if (candles.length === 0) return false;

      const indicators = computeAll(candles);
      const rsi = indicators.rsi;

      if (condition === 'rsi_above') return rsi > targetValue;
      if (condition === 'rsi_below') return rsi < targetValue;
    }

    if (condition.startsWith('ai_signal_')) {
      const signal = await getSignal(alert.userId, pair, '1h');

      if (condition === 'ai_signal_buy') {
        return signal.signal === 'BUY' && signal.confidence > targetValue;
      }
      if (condition === 'ai_signal_sell') {
        return signal.signal === 'SELL' && signal.confidence > targetValue;
      }
    }

    if (condition === 'pattern_detected') {
      const candles = await getOHLCV(pair, '1h');
      if (candles.length === 0) return false;

      const indicators = computeAll(candles);
      return indicators.patterns.includes(targetPattern);
    }

    return false;
  } catch (error) {
    console.error(`Error evaluating condition ${condition}:`, error);
    return false;
  }
}
