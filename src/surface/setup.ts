/**
 * setup.ts — `clawdcursor setup <editor>` implementation.
 *
 * Writes the clawdcursor MCP server block into an editor's config file
 * idempotently. The legacy install path was "hand-edit JSON files,"
 * which is the biggest single source of install-friction tickets.
 *
 * Supported editors live in setup-editors.ts. Each editor knows its
 * canonical file path per OS and its format (JSON or Codex-style TOML).
 *
 * Behavior:
 *   - Add when absent, replace when present (prints `added` vs `updated`)
 *   - Preserve every other key in the file (other MCP servers, settings)
 *   - Create parent dir + empty file if missing
 *   - Backup existing file to .bak before writing (skipped in --print)
 *   - --print emits the resulting full config to stdout, no file IO
 *   - --path <override> writes to a custom location (escape hatch)
 *   - --list prints supported editors + paths
 *   - Bad editor name prints the supported list and exits 2
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  EDITORS,
  CLAWDCURSOR_SERVER_BLOCK,
  SERVER_NAME,
  listEditorIds,
  getEditor,
  type EditorConfig,
  type PathResolution,
} from './setup-editors';

export interface SetupOpts {
  print?: boolean;
  path?: string;
  list?: boolean;
}

export type SetupAction = 'added' | 'updated' | 'printed' | 'listed' | 'shellout';

export interface SetupResult {
  action: SetupAction;
  /** Path written to (or that would be written) — undefined for `listed`. */
  path?: string;
  /** The resulting content for JSON or TOML editors. Empty for shellout/listed. */
  content?: string;
  /** Stdout lines the user sees. */
  messages: string[];
  /** Process exit code the CLI should propagate. */
  exitCode: number;
}

/**
 * Public entry point used by cli.ts.
 *
 * Resolves to void after printing messages and (unless --print) writing
 * the file. Throws only on bugs — invalid editor name or write failures
 * are reported via the returned exit code so the CLI can print cleanly.
 */
export async function runSetup(editor: string, opts: SetupOpts): Promise<void> {
  const result = await runSetupInner(editor, opts);
  for (const line of result.messages) {
    // Use process.stdout.write so we don't get a trailing newline from
    // console.log — many of our messages already end in \n where we want.
    process.stdout.write(line.endsWith('\n') ? line : line + '\n');
  }
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

/**
 * Internal, side-effect-light helper — usable from tests without
 * actually exiting the process. Performs file IO when opts.print is
 * false; otherwise stays read-only.
 */
export async function runSetupInner(editor: string, opts: SetupOpts): Promise<SetupResult> {
  // ── --list ──
  if (opts.list || editor === '--list') {
    return buildListResult();
  }

  if (!editor) {
    return {
      action: 'listed',
      messages: [
        'Error: clawdcursor setup requires an <editor> argument.',
        '',
        ...formatEditorList().split('\n'),
        '',
        'Run `clawdcursor setup --list` for full path details.',
      ],
      exitCode: 2,
    };
  }

  const cfg = getEditor(editor);
  if (!cfg) {
    return {
      action: 'listed',
      messages: [
        `Error: unknown editor "${editor}".`,
        '',
        'Supported editors:',
        ...formatEditorList().split('\n'),
      ],
      exitCode: 2,
    };
  }

  // ── Resolve target path (or shellout) ──
  const resolution = resolveTarget(cfg, opts);

  if (resolution.kind === 'unknown') {
    return {
      action: 'listed',
      messages: [
        `Error: could not determine the config path for ${cfg.name}.`,
        resolution.reason,
        resolution.tried.length > 0 ? `Tried: ${resolution.tried.join(', ')}` : '',
        '',
        `Workaround: pass --path <file> to override.`,
        `If you think this is a bug, please file an issue at https://github.com/AmrDab/clawdcursor/issues`,
      ].filter(Boolean),
      exitCode: 1,
    };
  }

  // Shellout path (claude-code): if the editor exposes its own `mcp add`
  // command, prefer that — it knows the right schema and scope semantics.
  // --path or --print override this, falling back to direct file writes.
  if (resolution.kind === 'shellout' && !opts.path && !opts.print) {
    return await runShellout(cfg, resolution.argv, resolution.description);
  }

  // For --print on a shellout editor, simulate the file path so we can
  // show what would be written. Use the documented fallback location.
  let filePath: string;
  let format: 'json' | 'toml';
  if (resolution.kind === 'shellout') {
    // For claude-code we know the file is ~/.claude.json — show its
    // mcpServers section so --print is useful for dry runs.
    filePath = opts.path ?? path.join(os.homedir(), '.claude.json');
    format = 'json';
  } else {
    filePath = opts.path ?? resolution.path;
    format = resolution.format;
  }

  // ── Read existing content (or default empty) ──
  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  // ── Merge ──
  let merged: string;
  let wasPresent: boolean;
  if (format === 'toml') {
    const r = mergeToml(existing);
    merged = r.text;
    wasPresent = r.wasPresent;
  } else {
    const r = mergeJson(existing);
    merged = r.text;
    wasPresent = r.wasPresent;
  }

  // ── --print mode: write to stdout, no file IO ──
  if (opts.print) {
    return {
      action: 'printed',
      path: filePath,
      content: merged,
      messages: [
        `# Would write to: ${filePath}`,
        `# Action: ${wasPresent ? 'update' : 'add'} ${SERVER_NAME}`,
        '',
        merged,
      ],
      exitCode: 0,
    };
  }

  // ── Write path ──
  // Create parent dir if missing.
  const parent = path.dirname(filePath);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (err) {
    return {
      action: 'listed',
      messages: [
        `Error: could not create parent directory ${parent}: ${(err as Error).message}`,
      ],
      exitCode: 1,
    };
  }

  // Backup if file exists.
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, filePath + '.bak');
    } catch (err) {
      return {
        action: 'listed',
        messages: [
          `Error: could not back up ${filePath} to .bak: ${(err as Error).message}`,
        ],
        exitCode: 1,
      };
    }
  }

  try {
    fs.writeFileSync(filePath, merged, 'utf-8');
  } catch (err) {
    return {
      action: 'listed',
      messages: [
        `Error: could not write ${filePath}: ${(err as Error).message}`,
      ],
      exitCode: 1,
    };
  }

  const verb = wasPresent ? 'updated' : 'added';
  return {
    action: wasPresent ? 'updated' : 'added',
    path: filePath,
    content: merged,
    messages: [`${verb} ${SERVER_NAME} in ${filePath}`],
    exitCode: 0,
  };
}

function resolveTarget(cfg: EditorConfig, opts: SetupOpts): PathResolution {
  if (opts.path) {
    // --path override: treat the file as JSON unless it ends in .toml.
    const format: 'json' | 'toml' = opts.path.toLowerCase().endsWith('.toml') ? 'toml' : 'json';
    return { kind: 'file', path: opts.path, format };
  }
  return cfg.resolvePath(process.platform, os.homedir(), process.env);
}

function buildListResult(): SetupResult {
  return {
    action: 'listed',
    messages: [
      'Supported editors for `clawdcursor setup <editor>`:',
      '',
      ...formatEditorList().split('\n'),
      '',
      'Flags:',
      '  --print           Print the resulting config to stdout (no file IO)',
      '  --path <file>     Override the target file (escape hatch)',
      '  --list            Show this list',
    ],
    exitCode: 0,
  };
}

function formatEditorList(): string {
  const lines: string[] = [];
  for (const id of listEditorIds()) {
    const cfg = EDITORS[id];
    const resolution = cfg.resolvePath(process.platform, os.homedir(), process.env);
    let pathStr: string;
    if (resolution.kind === 'file') pathStr = resolution.path;
    else if (resolution.kind === 'shellout') pathStr = resolution.description;
    else pathStr = `(unsupported on ${process.platform})`;
    lines.push(`  ${id.padEnd(13)} ${cfg.name}`);
    lines.push(`                ${pathStr}`);
  }
  return lines.join('\n');
}

/**
 * Spawn the editor's own `mcp add` subcommand. This is the preferred
 * install path when the editor ships a CLI that handles scope/schema
 * for us. Returns a SetupResult that the caller can route to stdout.
 *
 * On ENOENT (command not on PATH), we fall through to direct file
 * writes by setting exitCode to 127 and telling the user to pass
 * --path or install the CLI.
 */
function runShellout(cfg: EditorConfig, argv: string[], description: string): Promise<SetupResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    let stdoutBuf = '';
    let stderrBuf = '';
    let spawned: ReturnType<typeof spawn>;
    try {
      spawned = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch (err) {
      resolve({
        action: 'listed',
        messages: [
          `Error: could not spawn \`${cmd}\` for ${cfg.name}.`,
          `Reason: ${(err as Error).message}`,
          `Workaround: install \`${cmd}\` and re-run, or pass --path <file>.`,
        ],
        exitCode: 1,
      });
      return;
    }
    spawned.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
    spawned.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
    spawned.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT: editor's CLI is not on PATH. Be helpful — explain how
      // to fix and offer the --path escape hatch.
      if (err.code === 'ENOENT') {
        resolve({
          action: 'listed',
          messages: [
            `Error: \`${cmd}\` not found on PATH (needed for ${cfg.name}).`,
            `Install ${cfg.name} first, or pass --path <file> to write the config directly.`,
            `Equivalent command: ${argv.join(' ')}`,
          ],
          exitCode: 127,
        });
      } else {
        resolve({
          action: 'listed',
          messages: [
            `Error spawning \`${cmd}\`: ${err.message}`,
          ],
          exitCode: 1,
        });
      }
    });
    spawned.on('close', (code: number | null) => {
      if (code === 0) {
        const lines = [
          `added ${SERVER_NAME} via ${cfg.name} CLI`,
          `  (${description})`,
        ];
        if (stdoutBuf.trim()) lines.push(stdoutBuf.trimEnd());
        resolve({
          action: 'shellout',
          messages: lines,
          exitCode: 0,
        });
      } else {
        const lines = [
          `Error: \`${argv.join(' ')}\` exited with code ${code}.`,
        ];
        if (stderrBuf.trim()) lines.push(stderrBuf.trimEnd());
        if (stdoutBuf.trim()) lines.push(stdoutBuf.trimEnd());
        lines.push(`Workaround: pass --path <file> to write the JSON directly.`);
        resolve({
          action: 'listed',
          messages: lines,
          exitCode: code ?? 1,
        });
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge the clawdcursor server block into a JSON document at
 * `.mcpServers.clawdcursor`. Preserves all other keys.
 *
 * Empty / invalid input is treated as `{}`. Output is pretty-printed
 * with 2-space indent + trailing newline — the convention used by
 * Claude Desktop, Cursor, and the rest of the mcpServers ecosystem.
 */
export function mergeJson(existing: string): { text: string; wasPresent: boolean } {
  let doc: any = {};
  const trimmed = existing.trim();
  if (trimmed.length > 0) {
    try {
      doc = JSON.parse(trimmed);
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        // Not a JSON object at the root — replace with a fresh one. We
        // don't want to silently destroy the user's data, but a config
        // file that isn't `{}` was already broken. Wrap and continue.
        doc = {};
      }
    } catch {
      // Unparseable JSON — treat as empty so we still produce a valid
      // file. The .bak preserves whatever was there.
      doc = {};
    }
  }

  if (!doc.mcpServers || typeof doc.mcpServers !== 'object') {
    doc.mcpServers = {};
  }
  const wasPresent = Object.prototype.hasOwnProperty.call(doc.mcpServers, SERVER_NAME);
  doc.mcpServers[SERVER_NAME] = {
    command: CLAWDCURSOR_SERVER_BLOCK.command,
    args: [...CLAWDCURSOR_SERVER_BLOCK.args],
  };

  return {
    text: JSON.stringify(doc, null, 2) + '\n',
    wasPresent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOML merge — minimal, scoped to the [mcp_servers.<id>] shape that
// Codex CLI uses. We do NOT attempt to be a general TOML parser. The
// strategy:
//
//   1. Read the file as text.
//   2. Locate the block beginning at `[mcp_servers.<SERVER_NAME>]` (and
//      ending at the next `[...]` table header or EOF).
//   3. If found, replace it. Otherwise, append a new block.
//   4. Leave every other line untouched.
//
// This preserves comments, formatting, ordering, and any other tables
// the user has. It does NOT handle inline tables like
// `mcp_servers = { clawdcursor = { ... } }` — Codex doesn't write that
// shape, and we never emit it.
// ─────────────────────────────────────────────────────────────────────────────

const TOML_TABLE_HEADER = `[mcp_servers.${SERVER_NAME}]`;

/**
 * Format the clawdcursor block in Codex's TOML schema.
 */
function formatTomlBlock(): string {
  const argsList = CLAWDCURSOR_SERVER_BLOCK.args
    .map((a) => `"${a.replace(/"/g, '\\"')}"`)
    .join(', ');
  return [
    TOML_TABLE_HEADER,
    `command = "${CLAWDCURSOR_SERVER_BLOCK.command}"`,
    `args = [${argsList}]`,
  ].join('\n');
}

/**
 * Merge the clawdcursor block into a TOML document. Returns the new
 * text and whether a previous entry was present.
 */
export function mergeToml(existing: string): { text: string; wasPresent: boolean } {
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const headerIdx = findTomlTableStart(lines, TOML_TABLE_HEADER);
  const block = formatTomlBlock();

  if (headerIdx === -1) {
    // Append. Make sure we have a blank line before our block if the
    // file isn't empty, and a trailing newline at EOF.
    const trimmedEnd = trimTrailingBlank(lines);
    const parts: string[] = [];
    if (trimmedEnd.length > 0) {
      parts.push(trimmedEnd.join('\n'));
      parts.push(''); // separator blank line
    }
    parts.push(block);
    return { text: parts.join('\n') + '\n', wasPresent: false };
  }

  // Replace existing block. Find its end (next table header or EOF).
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Drop a trailing blank line inside the replaced block so we don't
  // duplicate spacing when we re-insert.
  while (endIdx > headerIdx + 1 && lines[endIdx - 1].trim() === '') {
    endIdx--;
  }

  const before = lines.slice(0, headerIdx);
  const after = lines.slice(endIdx);

  const merged: string[] = [];
  merged.push(...before);
  merged.push(...block.split('\n'));
  if (after.length > 0) {
    // Re-introduce a separator blank line between our block and the
    // next table (if there isn't one already).
    if (after[0].trim() !== '') merged.push('');
    merged.push(...after);
  }
  const text = merged.join('\n');
  return {
    text: text.endsWith('\n') ? text : text + '\n',
    wasPresent: true,
  };
}

function findTomlTableStart(lines: string[], header: string): number {
  const normalized = header.replace(/\s+/g, '');
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripTomlComment(lines[i]).replace(/\s+/g, '');
    if (stripped === normalized) return i;
  }
  return -1;
}

function stripTomlComment(line: string): string {
  // A '#' inside a quoted string is rare in table headers and we don't
  // bother — table headers are always plain identifiers in Codex configs.
  const hash = line.indexOf('#');
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}
