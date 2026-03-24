/**
 * Intraday Refresh Service
 *
 * Handles hourly forecast refreshes for:
 * - Remaining hours today
 * - Full next day
 * - Full day after
 *
 * Uses pre-trained models from the model store for fast generation.
 *
 * NOTE: This is a Phase 3 stub implementation.
 */

import { DateTime } from 'luxon';
import { generateForecasts } from './forecastGenerator.js';

/**
 * Intraday refresh options
 */
export interface IntradayRefreshOptions {
  asOfDate?: string;              // Defaults to now
  forecastHorizonDays?: number;   // Days ahead to forecast (default: 2)
  demandOnly?: boolean;           // Only refresh demand forecasts
  cfacOnly?: boolean;             // Only refresh CFAC forecasts
  outputDir?: string;             // Output directory
}

/**
 * Intraday refresh result
 */
export interface IntradayRefreshResult {
  success: boolean;
  asOfTime: string;
  hoursGenerated: number;
  demandForecasts: number;
  cfacForecasts: number;
  outputFiles: string[];
  errors: string[];
}

/**
 * Run intraday forecast refresh
 *
 * STUB: Full implementation will be added after Phase 4
 */
export async function runIntradayRefresh(
  options: IntradayRefreshOptions = {}
): Promise<IntradayRefreshResult> {
  console.log('\n[Intraday Refresh] Stub implementation');
  console.log('Hourly forecast refresh will be integrated after Phase 4');
  console.log('');

  // Calculate forecast window
  const now = options.asOfDate
    ? DateTime.fromISO(options.asOfDate)
    : DateTime.now().setZone('Asia/Manila');

  const forecastHorizonDays = options.forecastHorizonDays || 2;

  // Remaining hours today
  const remainingToday = 24 - now.hour;

  // Full days ahead
  const fullDaysAhead = forecastHorizonDays;

  const totalHours = remainingToday + (fullDaysAhead * 24);

  console.log(`Forecast window:`);
  console.log(`  As of: ${now.toISO()}`);
  console.log(`  Remaining today: ${remainingToday} hours`);
  console.log(`  Full days ahead: ${fullDaysAhead} days`);
  console.log(`  Total hours: ${totalHours}`);
  console.log('');

  console.log('Steps:');
  console.log('  1. Fetch latest weather forecasts');
  console.log('  2. Load active models from store');
  console.log('  3. Generate predictions for all entities');
  console.log('  4. Write incremental output files');
  console.log('  5. Push to gateway (if enabled)');

  // TODO: Implement actual refresh logic

  return {
    success: true,
    asOfTime: now.toISO() || '',
    hoursGenerated: totalHours,
    demandForecasts: 0,
    cfacForecasts: 0,
    outputFiles: [],
    errors: [],
  };
}

/**
 * Schedule intraday refresh to run hourly
 *
 * STUB: Will be integrated with scheduler service
 */
export function scheduleIntradayRefresh(options: IntradayRefreshOptions = {}): void {
  console.log('\n[Intraday Scheduler] Stub implementation');
  console.log('Hourly scheduling will be added after Phase 4');
  console.log('');
  console.log('Recommended cron schedule:');
  console.log('  */60 * * * * - Run every hour');
  console.log('  0 5-22 * * * - Run hourly from 5 AM to 10 PM');
  console.log('');
  console.log('Integration with existing scheduler:');
  console.log('  node dist/index.js scheduler run --refresh');
}
