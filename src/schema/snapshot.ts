/**
 * MCP schema snapshot helpers.
 *
 * Canonicalizes the tool registry for the snapshot file at repo root, and
 * provides read/write/compare helpers used by both the build script and the
 * vitest test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAllTools, toJsonSchema } from '../tools';

export interface CanonicalTool {
  name: string;
  description: string;
  category: string;
  parameters: object;
}

export interface SnapshotFile {
  version: 1;
  tools: CanonicalTool[];
}

/** Canonical sorted list of tools used for snapshot comparison. */
export function canonicalize(): CanonicalTool[] {
  const tools = getAllTools();
  return tools
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => ({
      name: t.name,
      description: t.description,
      category: t.category,
      parameters: toJsonSchema(t.parameters),
    }));
}

/** Serialized snapshot string — deterministic across runs. */
export function currentSnapshot(): string {
  const payload: SnapshotFile = { version: 1, tools: canonicalize() };
  return JSON.stringify(payload, null, 2) + '\n';
}

/** Resolve the committed snapshot file at repo root. */
export function snapshotPath(): string {
  // This file lives at src/schema/snapshot.ts → repo root is two levels up.
  return path.resolve(__dirname, '..', '..', 'schema.snapshot.json');
}

/** Read the stored snapshot; null if missing.
 *  EOLs are normalized to LF so Windows autocrlf checkouts don't
 *  cause spurious diffs against `currentSnapshot()` (which writes
 *  literal '\n'). The .gitattributes rule is the primary fix; this
 *  is defense-in-depth. */
export function readStoredSnapshot(): string | null {
  const p = snapshotPath();
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/** Write the current snapshot to the committed file. */
export function writeSnapshot(): void {
  fs.writeFileSync(snapshotPath(), currentSnapshot());
}
