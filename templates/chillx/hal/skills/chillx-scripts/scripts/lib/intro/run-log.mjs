/**
 * scripts/lib/intro/run-log.mjs
 *
 * Append-only run log for the introspection discipline.
 * Each run entry captures: timestamp, discipline used, task summary, outcome, harness adequacy.
 *
 * Log lives at ~/.claude/projects/-home-eggers-nanoclaw/intro/run-log.jsonl
 * (separate from memory/ so introspection data doesn't pollute memory loading).
 *
 * Self-review trigger: every 10th entry is followed by an automatic
 * "introspection self-review" prompt — see SELF_REVIEW_CADENCE.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.claude/projects/-home-eggers-nanoclaw/intro');
const LOG_PATH = path.join(LOG_DIR, 'run-log.jsonl');
const COUNTER_PATH = path.join(LOG_DIR, 'counter.txt');

export const SELF_REVIEW_CADENCE = 10;

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Append a run entry. Returns the entry written (with assigned id + timestamp).
 *
 * entry: {
 *   discipline: 'lock-execute' | 'bounded-judgment' | 'investigation' | 'generative-bounded' | 'creative-design' | 'introspection',
 *   task: 'short human description',
 *   outcome: 'success' | 'partial' | 'failed' | 'noop',
 *   details: { ... arbitrary structured data ... }
 * }
 */
export async function logRun(entry) {
  ensureDir();
  const now = new Date().toISOString();
  const id = nextCounter();
  const full = { id, timestamp: now, ...entry };
  fs.appendFileSync(LOG_PATH, JSON.stringify(full) + '\n');
  return full;
}

function nextCounter() {
  ensureDir();
  let n = 0;
  if (fs.existsSync(COUNTER_PATH)) n = parseInt(fs.readFileSync(COUNTER_PATH, 'utf-8'), 10) || 0;
  n += 1;
  fs.writeFileSync(COUNTER_PATH, String(n));
  return n;
}

/**
 * Read recent entries (default last 20).
 */
export function readRecent(limit = 20) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => JSON.parse(l));
}

/**
 * Whether the next entry will trigger a self-review.
 */
export function isSelfReviewDue() {
  if (!fs.existsSync(COUNTER_PATH)) return false;
  const n = parseInt(fs.readFileSync(COUNTER_PATH, 'utf-8'), 10) || 0;
  return n > 0 && n % SELF_REVIEW_CADENCE === 0;
}
