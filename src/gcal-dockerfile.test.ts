/**
 * Dependency guard for the Google Calendar MCP server (host/vitest tree).
 *
 * `@cocal/google-calendar-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never sees
 * it.
 *
 * NOTE: this install landed after the Dockerfile refactor that moved global Node
 * CLIs into container/cli-tools.json (installed by install-cli-tools.sh via a
 * single pinned `pnpm install -g`). The add-gcal-tool skill's original version of
 * this test asserted a CALENDAR_MCP_VERSION ARG in the Dockerfile; this adaptation
 * asserts the manifest entry instead. Drop it and this goes red, signalling the
 * agent would boot without the `google-calendar-mcp` binary on PATH.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

interface CliTool {
  name: string;
  version: string;
  onlyBuilt?: boolean;
}

function cliTools(): CliTool[] {
  const p = path.resolve(process.cwd(), 'container/cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CliTool[];
}

describe('container/cli-tools.json installs @cocal/google-calendar-mcp', () => {
  it('pins the package to an exact version', () => {
    const entry = cliTools().find((t) => t.name === '@cocal/google-calendar-mcp');
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('2.6.1');
  });
});
