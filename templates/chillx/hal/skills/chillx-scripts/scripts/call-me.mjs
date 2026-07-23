#!/usr/bin/env node
/**
 * call-me.mjs — HAL calls the owner's cell (Voice-HAL, OUTBOUND-ONLY).
 *
 * POSTs the PBX /hal-call endpoint, which token-gates the request and can
 * ONLY originate to numbers in the PBX AstDB chillx/hal_callers allowlist
 * (the security boundary — see flow-v2-design.md amendment 2026-07-23).
 * On answer, the call lands in the hal-voice persona (HAL's phone voice).
 *
 * Auth: x-hal-token = HAL_CALL_TOKEN, loaded from CHILLX_ENV_FILE ||
 * /workspace/agent/.chillx-env (machine-local; never print it).
 *
 * DRY=1 env → validation-only run (?dry=1): token + allowlist are checked
 * on the PBX but no call is placed.
 */
import { readFileSync, existsSync } from 'node:fs';

const ENV_FILE = process.env.CHILLX_ENV_FILE || '/workspace/agent/.chillx-env';
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const token = process.env.HAL_CALL_TOKEN;
if (!token) {
  console.error(`HAL_CALL_TOKEN not set (checked process.env and ${ENV_FILE}).`);
  process.exit(1);
}

const OWNER_CELL = '5122968114';
const dry = process.env.DRY === '1';
const url = 'https://pbx.chillxchillers.com/callerinfo/hal-call' + (dry ? '?dry=1' : '');

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hal-token': token },
    body: JSON.stringify({ to: OWNER_CELL }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    console.error(`hal-call failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(dry
    ? 'DRY OK — PBX validated token + allowlist; no call placed.'
    : `Calling the owner's cell now (channel ${body.channelId || 'n/a'}) — HAL greets on answer.`);
} catch (err) {
  console.error(`hal-call error: ${err.message}`);
  process.exit(1);
}
