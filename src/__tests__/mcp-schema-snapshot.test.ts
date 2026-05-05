/**
 * MCP schema-snapshot gate.
 *
 * Protects the public tool catalog (name, description, category, parameter
 * shape) from accidental drift. Any PR that changes the MCP surface will fail
 * this test until the snapshot is updated intentionally with:
 *   npx tsx scripts/build-mcp-schema.ts --write
 *
 * The user-visible contract v0.8.1 promises to freeze through v0.8.2.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { currentSnapshot, readStoredSnapshot, snapshotPath } from '../schema/snapshot';

describe('MCP schema snapshot', () => {
  it('matches the committed schema.snapshot.json', () => {
    const stored = readStoredSnapshot();
    expect(
      stored,
      'schema.snapshot.json missing. Generate with: npx tsx scripts/build-mcp-schema.ts --write',
    ).not.toBeNull();
    const current = currentSnapshot();
    expect(current).toEqual(stored);
  });

  it('snapshot file exists at repo root', () => {
    expect(fs.existsSync(snapshotPath()), 'schema.snapshot.json should be committed at repo root').toBe(true);
  });
});
