/**
 * Structural guard for the Gmail MCP package-install integration point (container image).
 *
 * `@gongrzhe/server-gmail-autoauth-mcp` is a CLI binary installed into the image — it is not
 * importable or typed from this tree, so the build leg can't catch its removal and there's no
 * runtime seam to behavior-test.
 *
 * NOTE: this install landed after the Dockerfile refactor that moved global Node CLIs into
 * container/cli-tools.json (installed by install-cli-tools.sh via a single pinned
 * `pnpm install -g`). The add-gmail-tool skill's original version of this test asserted a
 * GMAIL_MCP_VERSION ARG in the Dockerfile; this adaptation asserts the manifest entries
 * instead. Drop either entry and this goes red, signalling the agent would boot without the
 * `gmail-mcp` binary on PATH (or with the broken zod-to-json-schema resolution — see the
 * skill's SKILL.md for why that pin exists).
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

interface CliTool {
  name: string;
  version: string;
  onlyBuilt?: boolean;
}

function cliTools(): CliTool[] {
  // container/agent-runner/src/providers/ -> ../../../cli-tools.json == container/cli-tools.json
  const p = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('container/cli-tools.json installs the Gmail MCP server', () => {
  const tools = cliTools();

  it('pins @gongrzhe/server-gmail-autoauth-mcp to an exact version', () => {
    const entry = tools.find((t) => t.name === '@gongrzhe/server-gmail-autoauth-mcp');
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('1.1.11');
  });

  it('pins the zod-to-json-schema workaround version', () => {
    const entry = tools.find((t) => t.name === 'zod-to-json-schema');
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('3.22.5');
  });
});
