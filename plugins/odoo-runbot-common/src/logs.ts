import { BuildResult, LogLevel } from './types';

export interface ParsedLogLine {
  level: LogLevel;
  logger: string;
  message: string;
}

// 2026-10-27 10:15:02,123 4567 ERROR runbot_123 odoo.addons.sale.tests: FAIL: test_x
const ODOO_LINE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \d+ (DEBUG|INFO|WARNING|ERROR|CRITICAL|TEST|RUNBOT) \S+ ([\w.]+): (.*)$/;

/**
 * Parse one line of Odoo's log. Lines that aren't log records (tracebacks,
 * continuation lines) return undefined and belong to the previous record.
 */
export function parseOdooLogLine(line: string): ParsedLogLine | undefined {
  const m = ODOO_LINE.exec(line);
  if (!m) return undefined;
  const level = (m[1] === 'TEST' ? 'INFO' : m[1]) as LogLevel;
  return { level, logger: m[2], message: m[3] };
}

/** Log lines Odoo writes at WARNING that runbot doesn't count */
const IGNORED_WARNINGS = [
  /^Tests? .* took .* to (run|complete)/,
  /^Comparing .*:\s*$/,
];

export interface ResultInput {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  errors: number;
  warnings: number;
}

/**
 * Build result, as runbot reports it:
 * killed if stopped by a user; ko on a timeout, a non-zero exit or any ERROR
 * or CRITICAL line (failing tests log at ERROR); warn if any WARNING; else ok.
 */
export function buildResult(r: ResultInput): BuildResult {
  if (r.killed) return 'killed';
  if (r.timedOut || r.exitCode !== 0 || r.errors > 0) return 'ko';
  if (r.warnings > 0) return 'warn';
  return 'ok';
}

/** Whether a parsed line counts as an error or warning for the result */
export function classify(line: ParsedLogLine): 'error' | 'warning' | undefined {
  if (line.level === 'ERROR' || line.level === 'CRITICAL') return 'error';
  if (
    line.level === 'WARNING' &&
    !IGNORED_WARNINGS.some(r => r.test(line.message))
  )
    return 'warning';
  return undefined;
}
