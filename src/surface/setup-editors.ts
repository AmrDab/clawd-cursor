/**
 * setup-editors.ts — per-editor MCP config metadata for `clawdcursor setup`.
 *
 * Each entry describes:
 *   - canonical path of the MCP config file per OS
 *   - file format (JSON or TOML)
 *   - how to merge the clawdcursor server block in without trampling
 *     other settings the user has
 *
 * Adding a new editor: add an entry to EDITORS. Each editor has a
 * unique id (the CLI arg the user types) and a function `resolvePath`
 * that returns either:
 *   - { kind: 'file', path }      — write into this file
 *   - { kind: 'shellout', argv }  — preferred: use the editor's own
 *                                    `mcp add` subcommand if available
 *   - { kind: 'unknown', tried }  — could not determine canonical path;
 *                                    `setup` will fail loud and tell the
 *                                    user where to file the issue.
 *
 * Format = 'json' uses the standard mcpServers schema. Format = 'toml'
 * uses Codex's [mcp_servers.<id>] schema (TOML tables, not JSON).
 */

import * as path from 'path';

export type EditorFormat = 'json' | 'toml';

export type PathResolution =
  | { kind: 'file'; path: string; format: EditorFormat }
  | { kind: 'shellout'; argv: string[]; description: string }
  | { kind: 'unknown'; tried: string[]; reason: string };

export interface EditorConfig {
  /** CLI id the user types: `clawdcursor setup <id>` */
  id: string;
  /** Human-readable name shown in --list */
  name: string;
  /** One-line description shown in --list */
  description: string;
  /**
   * Resolve the target config path for the current platform.
   * Receives the platform string so tests can simulate different OSes
   * without mocking `os.platform()`.
   */
  resolvePath(platform: NodeJS.Platform, homedir: string, env: NodeJS.ProcessEnv): PathResolution;
}

/**
 * The clawdcursor MCP server block in the canonical mcpServers JSON
 * shape. Used by every JSON editor; TOML editors translate this to
 * their own table syntax.
 */
export const CLAWDCURSOR_SERVER_BLOCK = {
  command: 'clawdcursor',
  args: ['mcp', '--compact'],
} as const;

export const SERVER_NAME = 'clawdcursor';

/**
 * Map of supported editors. Order matters — used by --list output.
 */
export const EDITORS: Record<string, EditorConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude Desktop',
    description: 'Anthropic\'s Claude.app — uses claude_desktop_config.json',
    resolvePath(platform, homedir, env) {
      if (platform === 'darwin') {
        return {
          kind: 'file',
          path: path.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
          format: 'json',
        };
      }
      if (platform === 'win32') {
        const appdata = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        return {
          kind: 'file',
          path: path.join(appdata, 'Claude', 'claude_desktop_config.json'),
          format: 'json',
        };
      }
      if (platform === 'linux') {
        // Linux is unofficial — Claude Desktop ships for macOS/Windows.
        // Community builds (e.g. Bedrock) tend to use the XDG path.
        return {
          kind: 'file',
          path: path.join(homedir, '.config', 'Claude', 'claude_desktop_config.json'),
          format: 'json',
        };
      }
      return {
        kind: 'unknown',
        tried: [],
        reason: `Claude Desktop is not officially distributed on ${platform}.`,
      };
    },
  },

  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code CLI',
    description: 'Anthropic\'s `claude` CLI — uses `claude mcp add` when available',
    resolvePath(_platform, _homedir) {
      // Prefer shelling out to `claude mcp add --scope user` if claude is
      // on PATH — that's the canonical install path documented at
      // https://code.claude.com/docs/en/mcp. The CLI writes to
      // ~/.claude.json with the correct schema (and handles scope
      // semantics that aren't user-visible in the raw JSON).
      //
      // Falling back to writing ~/.claude.json directly is risky — the
      // file mixes per-project state with user-scope mcpServers — so
      // the shellout is the only canonical path. --path / --print
      // remain available as escape hatches.
      return {
        kind: 'shellout',
        argv: ['claude', 'mcp', 'add', '--scope', 'user', SERVER_NAME, '--', 'clawdcursor', 'mcp', '--compact'],
        description: `runs \`claude mcp add --scope user ${SERVER_NAME} -- clawdcursor mcp --compact\` (writes ~/.claude.json)`,
      };
    },
  },

  cursor: {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor IDE — uses ~/.cursor/mcp.json globally',
    resolvePath(_platform, homedir) {
      // Cursor uses the same path on all OSes. mcpServers schema matches
      // Claude Desktop's. See: https://cursor.com/docs (MCP section).
      return {
        kind: 'file',
        path: path.join(homedir, '.cursor', 'mcp.json'),
        format: 'json',
      };
    },
  },

  windsurf: {
    id: 'windsurf',
    name: 'Windsurf',
    description: 'Codeium Windsurf — uses ~/.codeium/windsurf/mcp_config.json',
    resolvePath(_platform, homedir) {
      // See: https://docs.windsurf.com/windsurf/cascade/mcp
      return {
        kind: 'file',
        path: path.join(homedir, '.codeium', 'windsurf', 'mcp_config.json'),
        format: 'json',
      };
    },
  },

  codex: {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    description: 'OpenAI\'s `codex` CLI — uses ~/.codex/config.toml (TOML)',
    resolvePath(_platform, homedir) {
      // See: https://developers.openai.com/codex/config-reference
      // MCP servers live under [mcp_servers.<id>] tables.
      return {
        kind: 'file',
        path: path.join(homedir, '.codex', 'config.toml'),
        format: 'toml',
      };
    },
  },
};

/**
 * Return the supported editor ids in display order. Used by --list and
 * the bad-editor error message.
 */
export function listEditorIds(): string[] {
  return Object.keys(EDITORS);
}

/**
 * Resolve an editor config by id. Returns null if unknown — the caller
 * is responsible for printing the supported list and exiting 2.
 */
export function getEditor(id: string): EditorConfig | null {
  return EDITORS[id] ?? null;
}
