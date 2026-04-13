/**
 * Persistent usage tracking — survives PM2 restarts.
 * Stores cumulative token counts and API-equivalent cost in SQLite.
 */

import type { Database } from "bun:sqlite";

// USD → CNY exchange rate (updated periodically)
const USD_TO_CNY = 7.0;

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalTurns: number;
}

let db: Database | null = null;

export function initUsageTracker(sqlite: Database): void {
  db = sqlite;
}

export function getHistoricalUsage(): UsageStats {
  if (!db) return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalTurns: 0 };

  const row = db.query("SELECT * FROM usage_stats WHERE id = 'global'").get() as any;
  if (!row) return { totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalTurns: 0 };

  return {
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCostUsd: row.total_cost_usd,
    totalTurns: row.total_turns,
  };
}

export function recordUsage(inputTokens: number, outputTokens: number, costUsd: number): void {
  if (!db) return;

  db.query(`
    UPDATE usage_stats SET
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cost_usd = total_cost_usd + ?,
      total_turns = total_turns + 1,
      updated_at = ?
    WHERE id = 'global'
  `).run(inputTokens, outputTokens, costUsd, Date.now());
}

export function formatCostCNY(usd: number): string {
  const cny = usd * USD_TO_CNY;
  if (cny >= 100) return `¥${cny.toFixed(0)}`;
  if (cny >= 1) return `¥${cny.toFixed(2)}`;
  return `¥${cny.toFixed(4)}`;
}

export function formatCostUSD(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export { USD_TO_CNY };
