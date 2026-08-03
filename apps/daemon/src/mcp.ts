// `od mcp` - stdio MCP server that proxies project tool calls to the
// running daemon's HTTP API. Lets a coding agent in a *different* repo
// (Claude Code, Cursor, Zed) pull files from a local Open Design
// project and create project-scoped artifacts without the
// export-zip-import dance.
//
// The server itself holds no state and never touches the filesystem;
// every tool resolves to a fetch() against `OD_DAEMON_URL`. Spawn the
// MCP server with no daemon running and tool calls return a clear
// "daemon not reachable" error - the server itself still launches so
// the client can list its tool schema.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildProjectRawFileUrl, findFirstQuestionForm } from '@open-design/contracts';
import { randomUUID } from 'node:crypto';

import { postCreateArtifactRequest } from './artifacts/create.js';

const SERVER_NAME = 'open-design';
const SERVER_VERSION = '0.2.0';
const MCP_STDIO_IDLE_EXIT_MS = 30 * 60 * 1000;

type JsonObject = Record<string, unknown>;
interface RunMcpOptions { daemonUrl: string | URL }
interface CatalogItem { id: string; name?: string; title?: string; description?: string; summary?: string }
interface SkillsPayload { skills?: CatalogItem[] }
interface PluginsPayload { plugins?: CatalogItem[] }
interface DesignSystemsPayload { designSystems?: CatalogItem[] }
interface ResourcePayload { skill?: { body?: string; content?: string }; designSystem?: { body?: string; content?: string }; body?: string; content?: string }
interface ProjectSummary { id: string; name: string; metadata?: JsonObject }
interface ProjectsPayload { projects?: ProjectSummary[] }
interface ProjectPayload { project?: ProjectSummary; id?: string; name?: string; metadata?: JsonObject; resolvedDir?: string }
interface ActiveContext { active?: boolean; projectId?: string; projectName?: string | null; fileName?: string | null; ageMs?: number | null }
type ResolvedProject = { id: string; name: string; source: 'uuid' | 'id' | 'exact' | 'slug' | 'substring' };
interface ProjectListCache { baseUrl: string; t: number; list: ProjectSummary[] }
interface McpArgs extends JsonObject { project?: unknown; entry?: unknown; include?: unknown; maxBytes?: unknown; path?: unknown; offset?: unknown; limit?: unknown; since?: unknown; query?: unknown; pattern?: unknown; max?: unknown; name?: unknown; content?: unknown; encoding?: unknown; artifactManifest?: unknown; confirm?: unknown; prompt?: unknown; initialRequest?: unknown; action?: unknown; additionalContext?: unknown; plugin?: unknown; inputs?: unknown; agent?: unknown; model?: unknown; serviceTier?: unknown; runId?: unknown; id?: unknown; sessionId?: unknown; conversationId?: unknown; questionId?: unknown; answer?: unknown; answers?: unknown; form?: unknown; designSystem?: unknown; skill?: unknown; includeUnavailable?: unknown }
interface ProjectFileBundleEntry { name: string; mime: string; size: number | null; content: string | null; binary: boolean }
interface BundleInput { project: ProjectPayload | ProjectSummary; entry: string; files: ProjectFileBundleEntry[]; truncated: boolean; active: ActiveContext | null; resolved?: ResolvedProject | null }
interface ErrorWithCode { message?: string; code?: string; cause?: { code?: string } }
interface PendingDiscoveryRun {
  initialRequest: string;
  discoveryResponse?: JsonObject;
}

const pendingDiscoveryRuns = new Map<string, PendingDiscoveryRun>();

interface McpIdleExitControllerOptions {
  idleMs: number;
  onIdle: () => void;
}

export function _createMcpIdleExitController({
  idleMs,
  onIdle,
}: McpIdleExitControllerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let disposed = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (disposed) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      if (inFlight > 0) {
        schedule();
        return;
      }
      disposed = true;
      onIdle();
    }, idleMs);
  };

  schedule();

  return {
    noteActivity() {
      schedule();
    },
    async trackRequest<T>(fn: () => T | Promise<T>): Promise<T> {
      if (disposed) {
        return fn();
      }
      inFlight += 1;
      schedule();
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) {
          schedule();
        }
      }
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

// Mimes whose body we surface as MCP `text` content. Everything else
// returns a clear error directing the caller at list_files for
// metadata, until phase 2 adds binary support.
const TEXTUAL_MIME_PATTERNS = [
  /^text\//i,
  /^application\/json\b/i,
  /^application\/javascript\b/i,
  /^application\/typescript\b/i,
  /^application\/xml\b/i,
  /^application\/x-(yaml|toml|httpd-php|sh)\b/i,
  /\+json\b/i,
  /\+xml\b/i,
  /^image\/svg\+xml\b/i,
];

// Every tool here is a read against a local daemon owned by the
// current user, so they're all read-only, idempotent, and operate on
// a closed (project-scoped) namespace. Pull these into one constant
// so each tool def doesn't repeat them.
const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

// Description style: short, one purpose-line per tool. Active-context
// fallback is documented once in the server `instructions` block, so
// per-tool descriptions just say "project optional" and don't repeat
// the rationale - that saves ~150 tokens per tools/list response,
// shipped to the model on every session.
const PROJECT_ARG = {
  type: 'string',
  description: 'Project id (UUID) or name substring. Optional; defaults to the active project (expires after ~5 minutes of no Open Design activity).',
} as const;

const TOOL_DEFS = [
  {
    name: 'list_projects',
    description: 'List every Open Design project on this daemon.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List Open Design projects' },
  },
  {
    name: 'get_active_context',
    description:
      'Project + file the user has open in Open Design right now. Returns {active:false, hint:"..."} when no project is active so the agent can ask the user to interact with Open Design (the active context expires ~5 minutes after the last user interaction). Most tools default to this when project is omitted, so you rarely need to call this directly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'What is the user looking at?' },
  },
  {
    name: 'get_artifact',
    description:
      'PREFER THIS over multiple get_file calls. Bundles the entry file plus every sibling it references (HTML <script>/<link>/<img>/srcset, JSX import/require, CSS url()/@import) up to depth 3, skipping CDN/data URLs. include="all" returns every file in the project; include="shallow" returns just the entry.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        entry: {
          type: 'string',
          description:
            "Entry file path relative to project root. Defaults to the active file or project's metadata.entryFile. Active-file fallback expires after ~5 minutes of no Open Design activity.",
        },
        include: {
          type: 'string',
          enum: ['auto', 'all', 'shallow'],
          description: 'auto (default) | all | shallow',
        },
        maxBytes: {
          type: 'number',
          description:
            'Soft cap on total text bytes (default 1_500_000). Also capped at 200 files. Excess files are dropped and truncated:true is set.',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Pull design bundle' },
  },
  {
    name: 'get_project',
    description:
      'Single project metadata: name, active skill/design-system ids, entryFile, kind, timestamps, resolvedDir, and (when it has an entry file) a browser-openable previewUrl.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_ARG },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Get Open Design project' },
  },
  {
    name: 'get_file',
    description:
      'Read one project file. Text mimes only (HTML, JSX, CSS, JSON, SVG, Markdown). Binary files return an error; use list_files for metadata. Returns up to `limit` lines starting at `offset` (defaults: offset=0, limit=2000), mirroring Claude Code\'s Read tool. For files longer than the slice, the response carries an `[od:file-window ...]` marker with totalLines so you can page by re-calling with the next offset. For multi-file designs prefer get_artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          type: 'string',
          description:
            'File path relative to project root, forward slashes. Optional; defaults to the active file when project is also omitted. Active-file fallback expires after ~5 minutes of no Open Design activity.',
        },
        offset: {
          type: 'number',
          description: '0-indexed starting line of the slice to return. Defaults to 0.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return. Defaults to 2000.',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Read project file' },
  },
  {
    name: 'search_files',
    description:
      'Case-insensitive literal-substring search across textual files in a project. Returns up to max matches with file, 1-indexed line, and snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        query: {
          type: 'string',
          description: 'Literal substring (not a regex), case-insensitive.',
        },
        pattern: {
          type: 'string',
          description: 'Optional glob on file name, e.g. "*.jsx".',
        },
        max: {
          type: 'number',
          description: 'Cap on matches (default 200, hard cap 1000).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Search project files' },
  },
  {
    name: 'list_files',
    description:
      'Project file metadata: name, path, mime, kind, size, mtime, optional artifactManifest. Pass since=<unix-ms> to cheap-poll for changes.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        since: {
          type: 'number',
          description: 'Unix-ms; only return files with mtime > since.',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List project files' },
  },
  {
    name: 'create_artifact',
    description:
      'Create one normal Open Design project artifact entry file. Writes name+content, rejects existing targets, and persists artifactManifest when supplied. HTML, Markdown, and SVG entries get a default manifest when omitted. Project optional; defaults to the active project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        name: {
          type: 'string',
          description: 'Output path relative to the project root, for example "codex-product/index.html" or "deck.html".',
        },
        content: {
          type: 'string',
          description: 'Entry file contents. Use encoding="base64" for base64 content.',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'utf8 (default) | base64',
        },
        artifactManifest: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional ArtifactManifest sidecar. If omitted, Open Design infers one for HTML, Markdown, or SVG entry files.',
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Create Open Design artifact' },
  },
  {
    name: 'write_file',
    description:
      'Write (or overwrite) a project file. Unlike create_artifact this does not require an ArtifactManifest and tolerates existing targets, so it is the right tool for iterating on a file the agent (or the user) already created. Project optional; defaults to the active project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          type: 'string',
          description: 'Output path relative to the project root, e.g. "deck.html" or "components/Hero.tsx".',
        },
        content: {
          type: 'string',
          description: 'File contents. Use encoding="base64" for binary payloads.',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          description: 'utf8 (default) | base64',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Write Open Design project file' },
  },
  {
    name: 'delete_file',
    description:
      'Delete one file from a project. Supports nested paths (e.g. "codex-product/index.html"). Project optional; defaults to the active project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          type: 'string',
          description: 'Project-relative path of the file to delete.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true, title: 'Delete Open Design project file' },
  },
  {
    name: 'delete_project',
    description:
      'Permanently delete an Open Design project including its files and conversations. Requires both an explicit project id/name AND confirm:true — there is no active-project fallback because the operation is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project id (UUID) or name substring. Required — active-context fallback is intentionally disabled.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be literally true. Guards against an agent accidentally deleting a project while cleaning up.',
        },
      },
      required: ['project', 'confirm'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true, title: 'Delete Open Design project' },
  },
  {
    name: 'create_project',
    description:
      'Create a new empty Open Design project to generate into, then call start_run against it. Returns the project (with its id) plus a conversationId. The id is derived from name unless you pass one explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable project name.' },
        id: {
          type: 'string',
          description: 'Optional project id slug ([A-Za-z0-9._-], <=128 chars). Derived from name when omitted.',
        },
        designSystem: {
          type: 'string',
          description: 'Optional design system id to attach (see the od://design-systems/... resources).',
        },
        skill: { type: 'string', description: 'Optional skill id to seed the project with.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Create Open Design project' },
  },
  {
    name: 'begin_discovery',
    description:
      'Ask the Open Design inner agent to turn a natural-language design request into one complete question-form without creating files. Poll get_run; when this discovery run succeeds, get_run automatically parses and persists the form as a discovery session and returns it for exact display.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        prompt: { type: 'string', description: 'The user\'s natural-language design request.' },
        agent: { type: 'string', description: 'Optional Open Design inner agent id.' },
        model: { type: 'string', description: 'Optional model override.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Begin Open Design discovery' },
  },
  {
    name: 'start_discovery',
    description:
      'Persist a complete Open Design single-shot question form together with the user\'s original request. Show the full form, including its options and recommendations, and wait for the user to review, accept defaults, skip, or provide answers; never submit inferred answers.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        conversationId: { type: 'string', description: 'Conversation id. If omitted, the project default conversation is used.' },
        id: { type: 'string', description: 'Optional discovery session id.' },
        initialRequest: {
          type: 'string',
          description: 'The user\'s exact original design request. Preserve it verbatim so skipped or partial forms still have useful generation context.',
        },
        form: {
          type: 'object',
          description: 'Question form produced by Open Design. Must contain id, title, and a non-empty questions array.',
          additionalProperties: true,
        },
      },
      required: ['form'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Start Open Design discovery' },
  },
  {
    name: 'get_discovery',
    description: 'Read the persisted discovery session, including the complete form and answers collected so far.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Discovery session id returned by start_discovery.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Read discovery session' },
  },
  {
    name: 'submit_discovery',
    description:
      'Finalize the Open Design single-shot form after the user explicitly chooses an action: submit answers, accept recommended defaults, or skip the form. Optional additionalContext preserves free-form requirements outside the listed options. Never infer an action or answer. The result includes the persisted brief.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Discovery session id returned by start_discovery.' },
        action: {
          type: 'string',
          enum: ['submit', 'accept_defaults', 'skip'],
          description: 'The user\'s explicit choice. submit uses answers; accept_defaults uses form defaults; skip proceeds from the original request without form answers.',
        },
        answers: {
          type: 'object',
          description: 'Map from question id to user-confirmed answers. Optional for accept_defaults or skip. A null value explicitly skips one question.',
          additionalProperties: true,
        },
        additionalContext: {
          type: 'string',
          description: 'User-provided requirements, corrections, or preferences that do not fit the form options.',
        },
      },
      required: ['sessionId', 'action'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Submit Open Design discovery form' },
  },
  {
    name: 'generate_from_discovery',
    description:
      'Start exactly one Open Design generation run from a persisted ready discovery session. This reads the original request and confirmed brief from the daemon, so the outer agent must not copy, rewrite, summarize, or supplement the brief. Returns the normal runId for get_run polling.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A ready discovery session id returned by submit_discovery.' },
        skill: { type: 'string', description: 'Optional Open Design skill id.' },
        plugin: { type: 'string', description: 'Optional Open Design plugin id.' },
        inputs: { type: 'object', additionalProperties: true, description: 'Optional plugin inputs.' },
        agent: { type: 'string', description: 'Optional inner agent override.' },
        model: { type: 'string', description: 'Optional model override.' },
        serviceTier: { type: 'string', description: 'Optional service tier override.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Generate from confirmed discovery' },
  },
  {
    name: 'answer_discovery',
    description: 'Legacy sequential-interview helper. The primary scheme-2A path is submit_discovery with the complete form answers.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Discovery session id.' },
        questionId: { type: 'string', description: 'The id of the current question.' },
        answer: { description: 'The user answer. Its JSON type follows the question type.' },
      },
      required: ['sessionId', 'questionId', 'answer'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Answer discovery question' },
  },
  {
    name: 'cancel_discovery',
    description: 'Cancel a persisted discovery session so it cannot accept further answers.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Discovery session id.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Cancel discovery session' },
  },
  // Discovery + generation. An external coding agent does NOT run a
  // skill itself — it commissions Open Design to, via start_run. The
  // daemon then spawns ITS OWN agent (Claude Code / API fallback /…)
  // to do the work. So list_skills / list_plugins exist purely so the
  // caller can discover what it can ask OD to generate; start_run
  // kicks off the run and get_run polls it to completion. Design
  // systems stay resource-only (od://design-systems/...) since they're
  // reference material the caller opts into, not something to run.
  {
    name: 'list_skills',
    description: 'List Open Design skills you can pass to start_run as a recipe. Discovery only — Open Design runs the skill, not you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List Open Design skills' },
  },
  {
    name: 'list_plugins',
    description: 'List installed Open Design plugins (packaged design workflows) you can pass to start_run as plugin + inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List Open Design plugins' },
  },
  {
    name: 'start_run',
    description:
      'Commission Open Design to generate or refine a design. Open Design spawns its own agent to do the work and returns a runId immediately. Poll get_run(runId) until status is terminal, then get_artifact to pull the result. Project optional; defaults to the active project. Requires an existing project (create one first with create_project).',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        prompt: {
          type: 'string',
          description: 'What to make or change, in natural language. Optional when a plugin supplies its own brief.',
        },
        skill: {
          type: 'string',
          description: 'Skill id from list_skills to drive the run. Optional.',
        },
        plugin: {
          type: 'string',
          description: 'Plugin id from list_plugins to drive the run. Optional.',
        },
        inputs: {
          type: 'object',
          additionalProperties: true,
          description: 'Plugin inputs object (only meaningful with plugin). Optional.',
        },
        agent: {
          type: 'string',
          description: "Which agent Open Design should run, e.g. 'claude' | 'codex' | 'opencode'. Optional; defaults to the user's configured agent.",
        },
        model: {
          type: 'string',
          description: 'Model id override for the run. Optional.',
        },
        serviceTier: {
          type: 'string',
          description: "Service tier override for the selected model, e.g. 'priority' for Codex Fast. Optional.",
        },
      },
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Generate with Open Design' },
  },
  {
    name: 'get_run',
    description:
      'Poll a run started by start_run. Returns status (queued|running|succeeded|failed|canceled) plus error info. On success, adds previewUrl (open it in a browser to view the rendered design) and agentMessage (the inner agent\'s textual output reassembled from the event stream — show this when there is no previewUrl, e.g. when the agent asked the user a clarifying question instead of producing files).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id returned by start_run.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Check Open Design run' },
  },
  {
    name: 'cancel_run',
    description: 'Request cancellation of an in-flight run started by start_run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id returned by start_run.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Cancel Open Design run' },
  },
  {
    name: 'list_agents',
    description:
      'List the agent CLIs Open Design can run for start_run.agent. Returns only installed (available) agents by default — pass includeUnavailable:true to also see agents we know about but that are not on PATH (each carries an installUrl for the user). Each entry includes id, name, version, and up to 10 sample models (modelsCount carries the real total).',
    inputSchema: {
      type: 'object',
      properties: {
        includeUnavailable: {
          type: 'boolean',
          description: 'When true, include agents whose binary is not installed. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List Open Design agents' },
  },
];

export async function runMcpStdio({ daemonUrl }: RunMcpOptions): Promise<void> {
  const baseUrl = String(daemonUrl).replace(/\/$/, '');
  let closeTransportForIdle: (() => void) | null = null;
  const idleExit = _createMcpIdleExitController({
    idleMs: MCP_STDIO_IDLE_EXIT_MS,
    onIdle: () => closeTransportForIdle?.(),
  });
  const withMcpActivity =
    <Args extends unknown[], Result>(handler: (...args: Args) => Result | Promise<Result>) =>
      (...args: Args) =>
        idleExit.trackRequest(() => handler(...args));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        'Open Design (OD) is a local-first design workspace. The user typically',
        'has OD running on their machine; each project contains a rendered',
        'artifact (HTML/JSX/CSS) plus its source files.',
        '',
        'Active context: get_artifact, get_project, get_file, search_files,',
        'and list_files all accept project as OPTIONAL. When omitted, they',
        'default to the project the user has open in OD right now; get_file',
        'and get_artifact additionally default to the active file. So when',
        'the user says "this file" / "the design I have open" / "find X",',
        'just call the tool without project - no need to ask first. The',
        'response carries usedActiveContext so you can confirm which',
        'project/file you hit. Pass project explicitly to override.',
        '',
        'Pulling design context:',
        ' - get_artifact() - entry file PLUS every referenced sibling',
        '    (tokens CSS, JSX modules, imported assets) in one call.',
        '    PREFER THIS over multiple get_file calls when the user',
        '    wants to understand or extend a design.',
        ' - get_file(path) for a single known file. Returns up to 2000',
        '    lines starting at offset (default 0) and stamps a',
        '    [od:file-window ...] marker when the file is longer; page',
        '    by re-calling with the next offset.',
        ' - search_files(query) to find a class/component/copy string',
        '    without fetching every file.',
        ' - list_files for metadata only.',
        ' - create_artifact(name, content) to create one normal artifact',
        '    entry file in the active or specified project. It rejects',
        '    existing targets and can accept an artifactManifest sidecar.',
        ' - write_file(path, content) to overwrite or freshly create any',
        '    project file when an ArtifactManifest is not required.',
        '    Use this to iterate on a file create_artifact already wrote.',
        ' - delete_file(path) to remove one project file (nested paths ok).',
        ' - delete_project(project, confirm:true) for irreversible project',
        '    removal — requires explicit project + confirm:true.',
        ' - list_projects to discover what is available on this daemon.',
        ' - get_active_context() if you want the active project/file',
        '    explicitly without making any other tool call.',
        '',
        'To make Open Design GENERATE or refine a design (rather than just',
        'read/edit files), commission a run - you do not run skills yourself:',
        ' - list_skills / list_plugins to see what you can ask OD to make.',
        ' - list_agents when you need to pass start_run.agent — do not',
        '    guess "claude" / "codex" / "opencode"; only agents in the',
        '    returned list will actually spawn on this machine.',
        ' - create_project(name) first if you need a fresh project to',
        '    generate into; start_run requires an existing project.',
        ' - start_run(prompt, [skill], [plugin], [inputs]) kicks off generation in',
        '    the active or named project and returns a runId immediately.',
        '    Open Design spawns its own agent to do the work.',
        ' - get_run(runId) polls until status is succeeded/failed/canceled;',
        '    on success it returns a previewUrl you can open in a browser',
        '    and a hint to pull the files with get_artifact.',
        ' - cancel_run(runId) aborts an in-flight run.',
        '',
        'Discovery for vague design requests (single-form scheme 2-A):',
        ' - begin_discovery(project, prompt) asks the inner Open Design agent',
        '    to produce one complete question-form without writing files.',
        ' - Poll that run with get_run, parse its question-form, then call',
        '    start_discovery(project, form, initialRequest). Preserve the',
        '    user\'s exact request in initialRequest and show the entire form.',
        ' - Wait for an explicit user decision. submit_discovery supports',
        '    action=submit with answers, action=accept_defaults, or action=skip.',
        '    Put requirements outside the offered choices in additionalContext.',
        '    Never silently choose defaults or manufacture missing answers.',
        ' - After submit_discovery returns ready, call generate_from_discovery',
        '    with only the sessionId. Do NOT copy its brief into start_run:',
        '    generate_from_discovery reads the persisted authoritative brief',
        '    and starts exactly one generation run itself.',
        '',
        'Generation patience: Open Design runs typically take 5–30',
        'minutes. Polls returning status:running with unchanged file',
        'mtimes is the inner agent thinking, not a hang. Do NOT cancel',
        'and substitute write_file as a "faster" workaround — that',
        'throws away the pipeline\'s design quality and is exactly the',
        'failure mode this surface is meant to avoid. Poll every 30–60',
        'seconds, tell the user "still working" between polls, and let',
        'the run finish. Only call cancel_run if the user explicitly',
        'asks you to abort.',
        '',
        'Ambiguous-format requests: words like "PPT" / "deck" / "slides" /',
        '"presentation" / "document" / "PDF" / "doc" map to two different',
        'deliverables — Open Design natively produces browser-viewable',
        'HTML/SVG (including HTML-rendered decks), but the user may want a',
        'real binary file (.pptx / .docx / .pdf) which Open Design does NOT',
        'produce and which you would have to export yourself from OD\'s',
        'output. When the user\'s request is ambiguous, ASK them which one',
        'they want before kicking off work; do not silently pick one and do',
        'not run both paths in parallel.',
        '',
        'Project arguments accept either a UUID or a name substring',
        '(e.g. "recaptr"); the server resolves the latter. When a project',
        'is matched by slug or substring the response carries',
        'resolvedProject:{id,name} so you can confirm which project was',
        'resolved. Verify with the user if the match was unexpected.',
        '',
        'Reference material is exposed as MCP resources, not tools - read',
        'od://design-systems/<id>/DESIGN.md when you need the brand spec',
        'for a design (palette, typography, voice). Skills are similarly',
        'available at od://skills/<id>/SKILL.md but are mostly relevant',
        'when the user asks about how a particular artifact was generated.',
        '',
        'When extending an Open Design design in another codebase, pull',
        'the full bundle once with get_artifact and work from those files',
        'locally - do not fetch files one-by-one if you can avoid it.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, withMcpActivity(async () => ({
    tools: TOOL_DEFS,
  })));

  server.setRequestHandler(ListResourcesRequestSchema, withMcpActivity(async () => {
    const [skillsData, dsData] = await Promise.all([
      getJson<SkillsPayload>(`${baseUrl}/api/skills`).catch((): SkillsPayload => ({ skills: [] })),
      getJson<DesignSystemsPayload>(`${baseUrl}/api/design-systems`).catch((): DesignSystemsPayload => ({ designSystems: [] })),
    ]);
    const resources = [
      {
        uri: 'od://focus/active',
        name: 'Active Open Design context',
        description: 'The project/file the user has open in Open Design right now.',
        mimeType: 'application/json',
      },
    ];
    for (const s of skillsData?.skills || []) {
      resources.push({
        uri: `od://skills/${encodeURIComponent(s.id)}/SKILL.md`,
        name: `Skill: ${s.name || s.id}`,
        description: oneLine(s.description) ?? '',
        mimeType: 'text/markdown',
      });
    }
    for (const d of dsData?.designSystems || []) {
      resources.push({
        uri: `od://design-systems/${encodeURIComponent(d.id)}/DESIGN.md`,
        name: `Design system: ${d.title || d.name || d.id}`,
        description: oneLine(d.summary) ?? '',
        mimeType: 'text/markdown',
      });
    }
    return { resources };
  }));

  server.setRequestHandler(ReadResourceRequestSchema, withMcpActivity(async (req) => {
    const uri = req.params?.uri;
    if (uri === 'od://focus/active') {
      const data = await getJson<ActiveContext>(`${baseUrl}/api/active`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
    const m = String(uri || '').match(/^od:\/\/(skills|design-systems)\/([^/]+)\/(.+)$/);
    if (!m) {
      throw new Error(`unsupported resource URI: ${uri}`);
    }
    const [, kind, id] = m as [string, 'skills' | 'design-systems', string, string];
    const route = kind === 'skills' ? 'skills' : 'design-systems';
    const data = await getJson<ResourcePayload>(
      `${baseUrl}/api/${route}/${encodeURIComponent(decodeURIComponent(id))}`,
    );
    const text =
      data?.skill?.body ??
      data?.skill?.content ??
      data?.designSystem?.body ??
      data?.designSystem?.content ??
      data?.body ??
      data?.content ??
      '';
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text,
        },
      ],
    };
  }));

  server.setRequestHandler(CallToolRequestSchema, withMcpActivity(async (req) => {
    const name = req.params?.name;
    const args: McpArgs = (req.params?.arguments ?? {}) as McpArgs;
    return handleMcpToolCall(baseUrl, name, args);
  }));

  const transport = new StdioServerTransport();
  try {
    closeTransportForIdle = () => {
      void transport.close().catch(() => {});
    };
    await server.connect(transport);

    const sdkOnMessage = transport.onmessage;
    transport.onmessage = (...args) => {
      idleExit.noteActivity();
      sdkOnMessage?.(...args);
    };

    // server.connect() only *starts* the transport; it resolves once the
    // stdio reader is wired up, not when the stream closes. Hold the
    // process open until the client disconnects (stdin EOF) so the cli.ts
    // top-level `process.exit(0)` doesn't kill us mid-handshake.
    await new Promise<void>((resolve) => {
      const sdkOnClose = transport.onclose;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        idleExit.dispose();
        resolve();
      };
      transport.onclose = () => {
        sdkOnClose?.();
        done();
      };
      const closeTransportForStdin = () => {
        void transport.close().catch(() => done());
      };
      process.stdin.once('end', closeTransportForStdin);
      process.stdin.once('close', closeTransportForStdin);
    });
  } finally {
    idleExit.dispose();
    closeTransportForIdle = null;
  }
}

function ok(payload: unknown) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function requireString(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} is required (string).`);
  }
}

async function handleMcpToolCall(baseUrl: string, name: unknown, args: McpArgs) {
  try {
    switch (name) {
      case 'list_projects':
        return ok(await getJson<ProjectsPayload>(`${baseUrl}/api/projects`));
      case 'get_active_context': {
        const data = await getJson<ActiveContext>(`${baseUrl}/api/active`);
        if (!data || data.active === false) {
          return ok({
            active: false,
            hint: 'Open Design has no active project right now. The active context expires about 5 minutes after the last user interaction with Open Design, so the user may need to click into a project (or switch tabs inside one) to wake it up. Alternatively, pass project="<id-or-name>" to other tools to bypass active context entirely.',
          });
        }
        return ok(data);
      }
      case 'get_project': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        const data = await getJson<ProjectPayload>(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
        const project = data?.project ?? data;
        const resolvedDir = typeof data?.resolvedDir === 'string' ? data.resolvedDir : null;
        const declaredEntry = project?.metadata?.entryFile ?? null;
        const entryFile = await resolveProjectEntry(baseUrl, id, declaredEntry);
        const previewUrl = rawPreviewUrl(baseUrl, id, entryFile);
        // Build the studio deep link too — needs the project's
        // default conversation, which we look up once. Cheap to skip
        // when the daemon has no webBaseUrl configured.
        const webBase = await getWebBaseUrl(baseUrl);
        const conversationId = webBase ? await getDefaultConversationId(baseUrl, id) : null;
        const studioUrl = buildStudioUrl(webBase, id, conversationId, entryFile);
        return ok(
          withActiveEcho(
            {
              ...project,
              entryFile,
              kind: project?.metadata?.kind ?? null,
              resolvedDir,
              // previewUrl: open in a browser to view the rendered
              // design directly (HTML entries render; see
              // rawPreviewUrl). studioUrl: open the OD studio page
              // that shows the rendered file alongside the chat
              // history for the project. Both omitted when their
              // prerequisites aren't met.
              ...(previewUrl ? { previewUrl } : {}),
              ...(studioUrl ? { studioUrl } : {}),
            },
            active,
            resolved,
          ),
        );
      }
      case 'list_files': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        const params = new URLSearchParams();
        if (typeof args.since === 'number' && Number.isFinite(args.since)) params.set('since', String(args.since));
        const qs = params.toString();
        const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/files${qs ? `?${qs}` : ''}`;
        return ok(withActiveEcho(await getJson(url), active, resolved));
      }
      case 'get_file': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        let path = typeof args.path === 'string' ? args.path : '';
        if (!path && active && active.fileName) {
          path = active.fileName;
        }
        requireString(path, 'path');
        const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 2000;
        return await getFile(baseUrl, id, path, active, resolved, offset, limit);
      }
      case 'get_artifact':
        return await getArtifact(
          baseUrl,
          args.project,
          args.entry,
          args.include,
          args.maxBytes,
        );
      case 'search_files': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        requireString(args.query, 'query');
        const params = new URLSearchParams({ q: String(args.query) });
        if (args.pattern) params.set('pattern', String(args.pattern));
        if (args.max) params.set('max', String(args.max));
        return ok(
          withActiveEcho(
            await getJson(
              `${baseUrl}/api/projects/${encodeURIComponent(id)}/search?${params.toString()}`,
            ),
            active,
            resolved,
          ),
        );
      }
      case 'create_artifact':
        return await createArtifact(baseUrl, args);
      case 'write_file':
        return await writeFile(baseUrl, args);
      case 'delete_file':
        return await deleteFile(baseUrl, args);
      case 'delete_project':
        return await deleteProject(baseUrl, args);
      case 'create_project':
        return await createProject(baseUrl, args);
      case 'begin_discovery':
        return await beginDiscovery(baseUrl, args);
      case 'start_discovery':
        return await startDiscovery(baseUrl, args);
      case 'get_discovery':
        return await getDiscovery(baseUrl, args);
      case 'submit_discovery':
        return await submitDiscovery(baseUrl, args);
      case 'generate_from_discovery':
        return await generateFromDiscovery(baseUrl, args);
      case 'answer_discovery':
        return await answerDiscovery(baseUrl, args);
      case 'cancel_discovery':
        return await cancelDiscovery(baseUrl, args);
      case 'list_skills':
        return ok(await getJson<SkillsPayload>(`${baseUrl}/api/skills`));
      case 'list_plugins':
        return ok(await listPlugins(baseUrl));
      case 'list_agents':
        return ok(await listAgents(baseUrl, args.includeUnavailable === true));
      case 'start_run':
        return await startRun(baseUrl, args);
      case 'get_run':
        return await getRun(baseUrl, args);
      case 'cancel_run': {
        requireString(args.runId, 'runId');
        return ok(
          await postJson<JsonObject>(
            `${baseUrl}/api/runs/${encodeURIComponent(args.runId)}/cancel`,
            {},
          ),
        );
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(formatError(err, baseUrl));
  }
}

async function writeFile(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  // The daemon route requires its argv field to be called `name`; the
  // MCP-facing surface uses `path` to match the rest of the file tools.
  requireString(args.path, 'path');
  requireString(args.content, 'content');
  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  // No `artifact: true` and no `overwrite: false`: the route then takes
  // the default writeProjectFile path, which overwrites the target. This
  // is the exact shape `od files write` uses (see apps/daemon/src/cli.ts).
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/files`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: args.path, content: args.content, encoding }),
  });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  return ok(withActiveEcho(json, active, resolved));
}

async function deleteFile(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  requireString(args.path, 'path');
  // /api/projects/:id/raw/* accepts nested paths; /api/projects/:id/files/:name
  // does not. Mirror the create_artifact surface, which already lets agents
  // address files like "codex-product/index.html".
  const segments = args.path
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/raw/${segments.join('/')}`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  return ok(withActiveEcho(json, active, resolved));
}

async function deleteProject(baseUrl: string, args: McpArgs) {
  // Active-context fallback is intentionally disabled: the daemon's
  // DELETE /api/projects/:id is irreversible (purges the row and the
  // on-disk project directory), so we never want it to fire against the
  // wrong project just because the user happened to have one open. The
  // confirm flag is a second belt for agents that auto-clean.
  if (typeof args.project !== 'string' || args.project.length === 0) {
    return errorResult('project is required (no active-context fallback for delete_project).');
  }
  if (args.confirm !== true) {
    return errorResult('confirm:true is required to delete a project (this cannot be undone).');
  }
  const { id, resolved } = await resolveProjectArg(baseUrl, args.project);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  // The tool accepts a name substring (see resolveProjectId), so the
  // caller needs the resolvedProject echo to confirm which project was
  // actually destroyed — same contract write_file/delete_file follow
  // via withActiveEcho. active is always null here because the
  // active-context fallback is intentionally disabled above.
  return ok(withActiveEcho(json, null, resolved));
}

async function formatDaemonError(resp: Response, url: string): Promise<string> {
  const body = await safeText(resp);
  let detail = body || resp.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    if (parsed?.error?.message) {
      detail = `${parsed.error.code ?? 'error'}: ${parsed.error.message}`;
    }
  } catch {
    // body wasn't JSON; fall through with the raw text.
  }
  return `daemon ${resp.status} on ${url}: ${detail}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    throw new Error(await formatDaemonError(resp, url));
  }
  return (await resp.json()) as T;
}

// Create an empty project to generate into. start_run needs an existing
// project; without this an external agent could only work on projects
// the user had already created in Open Design.
//
// skipDiscoveryBrief defaults to true: the outer agent (Codex, Cursor,
// …) IS the user-facing surface, so OD's own interactive discovery
// stage would create a confusing nested-clarification loop where OD's
// <question-form> output ends up dropped from the MCP response because
// no project file is produced. Better to let the outer agent gather
// requirements directly and pass a precise prompt to start_run.
async function createProject(baseUrl: string, args: McpArgs) {
  requireString(args.name, 'name');
  const id =
    typeof args.id === 'string' && args.id.length > 0
      ? args.id
      : slugifyProjectId(args.name);
  const body: JsonObject = { id, name: args.name, skipDiscoveryBrief: true };
  if (typeof args.designSystem === 'string' && args.designSystem.length > 0) {
    body.designSystemId = args.designSystem;
  }
  if (typeof args.skill === 'string' && args.skill.length > 0) {
    body.skillId = args.skill;
  }
  return ok(await postJson<JsonObject>(`${baseUrl}/api/projects`, body));
}

async function beginDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.prompt, 'prompt');
  const discoveryPrompt = [
    'You are in Open Design discovery-only mode.',
    'Do not create, modify, or write any files.',
    'Do not start implementation or generation.',
    'Convert the user request below into exactly one complete <question-form> block.',
    'Ask only high-value questions needed to decide the design direction and implementation shape.',
    'Use Open Design\'s single-shot brief style: at most five high-value questions may cover the major dimensions of the request.',
    'Recommended default/defaultValue fields are allowed and should be clearly treated as suggestions, never as user answers.',
    'The form must be valid JSON with id, title, and a non-empty questions array.',
    'Each question needs id, label, and type; use options for a small set of choices when useful. Do not claim the user selected a recommendation unless the user explicitly confirms it.',
    'Return the question-form block as the final assistant message so the outer agent can parse it.',
    '',
    'User request:',
    String(args.prompt),
  ].join('\n');
  const result = await startRun(baseUrl, { ...args, prompt: discoveryPrompt });
  const payload = readMcpTextPayload(result);
  const runId = typeof payload?.runId === 'string'
    ? payload.runId
    : typeof payload?.id === 'string'
      ? payload.id
      : null;
  if (runId) {
    pendingDiscoveryRuns.set(runId, { initialRequest: String(args.prompt) });
  }
  return result;
}

function readMcpTextPayload(result: unknown): JsonObject | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (!first || typeof first !== 'object' || typeof (first as { text?: unknown }).text !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse((first as { text: string }).text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : null;
  } catch {
    return null;
  }
}

async function startDiscovery(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  if (!args.form || typeof args.form !== 'object' || Array.isArray(args.form)) {
    throw new Error('form must be an object produced by Open Design');
  }
  const form = args.form as JsonObject;
  if (
    typeof form.id !== 'string' ||
    typeof form.title !== 'string' ||
    !Array.isArray(form.questions) ||
    form.questions.length === 0
  ) {
    throw new Error('form must contain id, title, and a non-empty questions array');
  }
  const conversationId =
    typeof args.conversationId === 'string' && args.conversationId.length > 0
      ? args.conversationId
      : await getDefaultConversationId(baseUrl, id);
  requireString(conversationId, 'conversationId');
  const body: JsonObject = {
    projectId: id,
    conversationId,
    form,
    initialRequest: typeof args.initialRequest === 'string' ? args.initialRequest : '',
  };
  if (typeof args.id === 'string' && args.id.length > 0) body.id = args.id;
  return ok(
    withActiveEcho(
      await postJson<JsonObject>(`${baseUrl}/api/discovery-sessions`, body),
      active,
      resolved,
    ),
  );
}

async function getDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.sessionId, 'sessionId');
  return ok(
    await getJson<JsonObject>(
      `${baseUrl}/api/discovery-sessions/${encodeURIComponent(String(args.sessionId))}`,
    ),
  );
}

async function submitDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.sessionId, 'sessionId');
  requireString(args.action, 'action');
  if (args.action !== 'submit' && args.action !== 'accept_defaults' && args.action !== 'skip') {
    throw new Error('action must be submit, accept_defaults, or skip');
  }
  if (
    args.answers !== undefined &&
    (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers))
  ) {
    throw new Error('answers must be an object when provided');
  }
  if (args.additionalContext !== undefined && typeof args.additionalContext !== 'string') {
    throw new Error('additionalContext must be a string when provided');
  }
  return ok(
    await postJson<JsonObject>(
      `${baseUrl}/api/discovery-sessions/${encodeURIComponent(String(args.sessionId))}/submit`,
      {
        action: args.action,
        answers: args.answers ?? {},
        additionalContext: args.additionalContext ?? '',
      },
    ),
  );
}

async function generateFromDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.sessionId, 'sessionId');
  const discovery = await getJson<JsonObject>(
    `${baseUrl}/api/discovery-sessions/${encodeURIComponent(args.sessionId)}`,
  );
  const session = discovery.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('discovery session response is invalid');
  }
  const persisted = session as JsonObject;
  if (persisted.status !== 'ready') {
    throw new Error(`discovery session must be ready before generation (current: ${String(persisted.status)})`);
  }
  requireString(persisted.projectId, 'discovery session projectId');
  requireString(discovery.brief, 'discovery brief');
  // Discovery and generation have different responsibilities. The discovery
  // agent only produces the form; resuming that native CLI session during the
  // build can carry discovery-only instructions and an interrupted tool state
  // into generation. Persist the brief in our own discovery session, then
  // start the build in a fresh Open Design conversation/native agent session.
  const conversationResponse = await postJson<JsonObject>(
    `${baseUrl}/api/projects/${encodeURIComponent(String(persisted.projectId))}/conversations`,
    {
      title: 'Generate from confirmed discovery',
      sessionMode: 'design',
    },
  );
  const generationConversation = conversationResponse.conversation;
  if (
    !generationConversation ||
    typeof generationConversation !== 'object' ||
    Array.isArray(generationConversation)
  ) {
    throw new Error('generation conversation response is invalid');
  }
  requireString(
    (generationConversation as JsonObject).id,
    'generation conversation id',
  );
  const generationPrompt = [
    'Generate the project from the confirmed Open Design discovery brief below.',
    'Treat the brief as authoritative. Do not run discovery again, ask new questions, rewrite the brief, or substitute different requirements.',
    'Create and save the requested project files with a runnable preview entry.',
    'Filesystem contract: write every deliverable inside the active project directory only. For Write, Edit, and apply_patch, use project-relative paths such as index.html, styles.css, app.js, or pages/analytics.html. Never construct or mix absolute Windows/WSL paths (for example D:\\..., /mnt/d/..., or /mnt/D:/...).',
    'If one file operation fails, read its tool error, correct the path or patch, and continue. Before finishing, verify that the requested files exist in the active project directory. Do not report completion while any build todo remains pending or in progress.',
    '',
    discovery.brief,
  ].join('\n');
  return startRun(baseUrl, {
    project: persisted.projectId,
    conversationId: (generationConversation as JsonObject).id,
    prompt: generationPrompt,
    skill: args.skill,
    plugin: args.plugin,
    inputs: args.inputs,
    agent: args.agent,
    model: args.model,
    serviceTier: args.serviceTier,
  });
}

async function answerDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.sessionId, 'sessionId');
  requireString(args.questionId, 'questionId');
  if (args.answer === undefined) throw new Error('answer is required');
  return ok(
    await postJson<JsonObject>(
      `${baseUrl}/api/discovery-sessions/${encodeURIComponent(String(args.sessionId))}/answer`,
      { questionId: args.questionId, answer: args.answer },
    ),
  );
}

async function cancelDiscovery(baseUrl: string, args: McpArgs) {
  requireString(args.sessionId, 'sessionId');
  return ok(
    await postJson<JsonObject>(
      `${baseUrl}/api/discovery-sessions/${encodeURIComponent(String(args.sessionId))}/cancel`,
      {},
    ),
  );
}

// Flatten daemon's plugin record into the few fields an external agent
// needs to pick a plugin: id, title, description, kind, tags. The raw
// record carries 16+ fields (fsPath, sourceMarketplaceId, installedAt,
// resolvedSource, …) that an agent never reasons about, and the
// human-readable description / kind live one level deeper in
// `manifest.description` / `manifest.od.kind`.
async function listPlugins(baseUrl: string): Promise<JsonObject> {
  const raw = await getJson<{ plugins?: JsonObject[] }>(`${baseUrl}/api/plugins`);
  const plugins = (raw?.plugins ?? []).map((p) => {
    const manifest = (p?.manifest as JsonObject | undefined) ?? {};
    const od = (manifest.od as JsonObject | undefined) ?? {};
    const result: JsonObject = {
      id: p?.id,
      title: manifest.title ?? p?.title ?? p?.id,
    };
    if (typeof manifest.description === 'string') result.description = manifest.description;
    const kind = od.taskKind ?? od.kind;
    if (typeof kind === 'string') result.kind = kind;
    if (Array.isArray(manifest.tags)) result.tags = manifest.tags;
    return result;
  });
  return { plugins };
}

// Flatten daemon's agent definition into the few fields an external
// agent needs to pick a value for start_run.agent. Default filters to
// `available: true` (only installed CLIs) so the outer agent doesn't
// pick an agent it can't actually run — the failure mode that left us
// with zombie "running" runs whose inner Claude binary never spawned.
// Models are truncated to 10 with `modelsCount` carrying the full
// total; that keeps the response token-economical even for agents
// (e.g. opencode) that expose 100+ models.
async function listAgents(baseUrl: string, includeUnavailable: boolean): Promise<JsonObject> {
  const raw = await getJson<{ agents?: JsonObject[] }>(`${baseUrl}/api/agents`);
  const all = raw?.agents ?? [];
  const filtered = includeUnavailable
    ? all
    : all.filter((a) => a?.available === true);
  const MAX_MODELS = 10;
  const agents = filtered.map((a) => {
    const models = Array.isArray(a?.models) ? (a.models as unknown[]) : [];
    const out: JsonObject = {
      id: a?.id,
      name: a?.name,
      models: models.slice(0, MAX_MODELS),
      modelsCount: models.length,
    };
    if (typeof a?.version === 'string' && a.version.length > 0) out.version = a.version;
    if (includeUnavailable) {
      out.available = Boolean(a?.available);
      if (typeof a?.installUrl === 'string') out.installUrl = a.installUrl;
    }
    return out;
  });
  return { agents };
}

// Derive a valid project id ([A-Za-z0-9._-], <=128) from a display name,
// with a short random suffix so repeated creates with the same name
// don't collide on the daemon's primary key.
function slugifyProjectId(name: string): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) ||
    'project';
  return `${base}-${randomUUID().replace(/-/g, '').slice(0, 4)}`;
}

// Commission a generation run. The caller never runs the skill/plugin
// itself; we POST to /api/runs and the daemon spawns its own agent.
// Returns the runId immediately so the caller can poll get_run —
// start+poll because MCP is request/response and generation is
// minutes-long.
async function startRun(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  const body: JsonObject = { projectId: id };
  if (typeof args.conversationId === 'string' && args.conversationId.length > 0) {
    body.conversationId = args.conversationId;
  }
  if (typeof args.prompt === 'string' && args.prompt.length > 0) {
    body.message = args.prompt;
    body.currentPrompt = args.prompt;
  }
  if (typeof args.skill === 'string' && args.skill.length > 0) body.skillId = args.skill;
  if (typeof args.plugin === 'string' && args.plugin.length > 0) body.pluginId = args.plugin;
  if (typeof args.agent === 'string' && args.agent.length > 0) body.agentId = args.agent;
  if (typeof args.model === 'string' && args.model.length > 0) body.model = args.model;
  if (typeof args.serviceTier === 'string' && args.serviceTier.length > 0) {
    body.serviceTier = args.serviceTier;
  }
  if (args.inputs !== undefined) {
    if (args.inputs === null || typeof args.inputs !== 'object' || Array.isArray(args.inputs)) {
      throw new Error('inputs must be an object');
    }
    body.pluginInputs = args.inputs;
  }
  const created = await postJson<JsonObject>(`${baseUrl}/api/runs`, body);
  // Build studioUrl (conversation-level — no entry file yet) so the
  // outer agent has a URL to give the user right away. The daemon
  // returns conversationId in the response now that POST /api/runs
  // falls back to the project's default conversation for MCP callers.
  const webBase = await getWebBaseUrl(baseUrl);
  const studioUrl = buildStudioUrl(webBase, id, created?.conversationId, null);
  return ok(
    withActiveEcho(
      {
        ...created,
        ...(studioUrl ? { studioUrl } : {}),
        hint: 'Run started. Open Design generation normally takes 5–30 minutes. Polls showing status:running with no new files / unchanged file mtimes is the inner agent thinking, NOT a hang — DO NOT cancel_run out of impatience and DO NOT substitute write_file to produce the design yourself; OD\'s pipeline is what gives the result its design quality. Poll get_run(runId) every 30–60 seconds; report "still working" to the user between polls and keep waiting. On terminal status the response carries previewUrl + agentMessage which together are the canonical deliverable. When studioUrl is present, ALWAYS show it to the user as a clickable markdown link: `[Open Open Design studio](STUDIO_URL)` — never as inline code or bare text, because Codex / Cursor / Zed render markdown links as navigable in their built-in browser pane and inline code blocks are not clickable.',
      },
      active,
      resolved,
    ),
  );
}

type StaticDeliveryStatus = 'valid' | 'incomplete' | 'unavailable' | 'not_applicable';

function htmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function stylesheetReferences(html: string): string[] {
  const refs: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = htmlAttribute(tag, 'rel');
    const href = htmlAttribute(tag, 'href');
    if (href && rel?.split(/\s+/).some((value) => value.toLowerCase() === 'stylesheet')) {
      refs.push(href);
    }
  }
  return refs;
}

function countCssRenderRules(css: string): number {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let count = 0;
  // This deliberately stays a conservative static check rather than a full
  // CSS parser. It catches the important failure mode where a generated
  // stylesheet contains only :root tokens, while accepting ordinary rules
  // nested inside media/container queries.
  for (const match of withoutComments.matchAll(/([^{}]+)\{[^{}]*}/g)) {
    const selector = (match[1] ?? '').trim();
    if (!selector || selector.startsWith('@')) continue;
    const meaningful = selector
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .some((part) =>
        Boolean(
          part &&
          part !== ':root' &&
          part !== 'from' &&
          part !== 'to' &&
          !/^\d+(?:\.\d+)?%$/.test(part),
        ),
      );
    if (meaningful) count += 1;
  }
  return count;
}

function localStylesheetPath(raw: string, fromPath: string): string | null {
  if (/^(?:https?:|\/\/|data:)/i.test(raw)) return null;
  const dir = fromPath.includes('/')
    ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1)
    : '';
  const resolved = raw.startsWith('/') ? raw.slice(1) : dir + raw;
  const stripped = resolved.replace(/[?#].*$/, '');
  const segments = stripped.split('/').filter(Boolean);
  const output: string[] = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return null;
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return output.length > 0 ? output.join('/') : null;
}

async function validateStaticWebDelivery(
  baseUrl: string,
  projectId: string,
  entryFile: string,
): Promise<JsonObject> {
  if (!/\.html?$/i.test(entryFile)) {
    return { status: 'not_applicable' satisfies StaticDeliveryStatus, entryFile };
  }

  let entry: ProjectFileBundleEntry;
  try {
    entry = await fetchProjectFile(baseUrl, projectId, entryFile, 1_000_000);
  } catch (error) {
    const message = errorMessage(error);
    if (/daemon\s+404\b/i.test(message)) {
      return {
        status: 'incomplete' satisfies StaticDeliveryStatus,
        entryFile,
        checkedFiles: [],
        issues: [{ code: 'ENTRY_FILE_NOT_FOUND', path: entryFile, message }],
      };
    }
    return {
      status: 'unavailable' satisfies StaticDeliveryStatus,
      entryFile,
      reason: message,
    };
  }

  const files = new Map<string, ProjectFileBundleEntry>([[entryFile, entry]]);
  const issues: JsonObject[] = [];
  const queue = extractRelativeRefs(entry.content ?? '', entryFile, entry.mime)
    .map((path) => ({ path, depth: 1 }));
  const queued = new Set(queue.map((item) => item.path));
  const maxFiles = 40;
  let validationUnavailableReason: string | null = null;

  while (queue.length > 0 && files.size < maxFiles) {
    const next = queue.shift();
    if (!next || files.has(next.path)) continue;
    try {
      const file = await fetchProjectFile(baseUrl, projectId, next.path, 1_000_000);
      files.set(next.path, file);
      if (next.depth < 2 && !file.binary && typeof file.content === 'string') {
        for (const ref of extractRelativeRefs(file.content, next.path, file.mime)) {
          if (!files.has(ref) && !queued.has(ref)) {
            queued.add(ref);
            queue.push({ path: ref, depth: next.depth + 1 });
          }
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      if (/daemon\s+404\b/i.test(message)) {
        issues.push({
          code: 'MISSING_LOCAL_REFERENCE',
          path: next.path,
          message: `Referenced local file "${next.path}" was not found.`,
        });
      } else {
        validationUnavailableReason ??= message;
      }
    }
  }

  const entryHtml = entry.content ?? '';
  if (
    entryHtml.trim().length < 500 ||
    !/<body\b/i.test(entryHtml) ||
    !/<(?:main|section|article|nav|form|table)\b/i.test(entryHtml)
  ) {
    issues.push({
      code: 'HTML_ENTRY_TOO_THIN',
      path: entryFile,
      message: 'The HTML entry is too small or lacks meaningful page structure.',
    });
  }

  const stylesheetHrefs = stylesheetReferences(entryHtml);
  const inlineStyles = [...entryHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1] ?? '');
  const localStylesheets = stylesheetHrefs
    .map((href) => localStylesheetPath(href, entryFile))
    .filter((value): value is string => Boolean(value));
  const externalStylesheetCount = stylesheetHrefs.length - localStylesheets.length;
  const fetchedCss = [...files.values()].filter(
    (file) => isCssLike(file.mime, file.name) && typeof file.content === 'string',
  );

  if (localStylesheets.length === 0 && externalStylesheetCount === 0 && inlineStyles.length === 0) {
    issues.push({
      code: 'NO_PRESENTATIONAL_STYLES',
      path: entryFile,
      message: 'The HTML entry has no linked or inline stylesheet.',
    });
  }

  for (const css of fetchedCss) {
    if (countCssRenderRules(css.content ?? '') === 0) {
      issues.push({
        code: 'CSS_HAS_NO_RENDER_RULES',
        path: css.name,
        message: 'The stylesheet contains tokens or at-rules but no rules that style page elements.',
      });
    }
  }
  if (
    inlineStyles.length > 0 &&
    localStylesheets.length === 0 &&
    externalStylesheetCount === 0 &&
    inlineStyles.every((css) => countCssRenderRules(css) === 0)
  ) {
    issues.push({
      code: 'INLINE_CSS_HAS_NO_RENDER_RULES',
      path: entryFile,
      message: 'Inline CSS contains no rules that style page elements.',
    });
  }

  const metrics: JsonObject = {
    checkedFileCount: files.size,
    htmlFileCount: [...files.values()].filter((file) => isHtmlLike(file.mime, file.name)).length,
    cssFileCount: fetchedCss.length,
    jsFileCount: [...files.values()].filter((file) => isJsLike(file.mime, file.name)).length,
    totalTextBytes: [...files.values()].reduce(
      (total, file) => total + (typeof file.content === 'string' ? file.content.length : 0),
      0,
    ),
  };

  if (validationUnavailableReason) {
    return {
      status: 'unavailable' satisfies StaticDeliveryStatus,
      entryFile,
      checkedFiles: [...files.keys()],
      issues,
      metrics,
      reason: validationUnavailableReason,
    };
  }
  return {
    status: (issues.length > 0 ? 'incomplete' : 'valid') satisfies StaticDeliveryStatus,
    entryFile,
    checkedFiles: [...files.keys()],
    issues,
    metrics,
  };
}

// Poll a run. On terminal status we enrich the daemon's status body
// with three things the outer agent needs to actually close the loop:
// (1) previewUrl when there's an entry file — open this in a browser,
// (2) agentMessage = the inner agent's textual output reassembled from
//     the SSE event stream, so when the inner agent asked a discovery
//     question back instead of producing files, the outer agent can
//     relay it to the user (without this, the run looks like a
//     "succeeded with empty output" mystery), and
// (3) a hint that tells the outer agent how to surface both.
async function getRun(baseUrl: string, args: McpArgs) {
  requireString(args.runId, 'runId');
  const status = await getJson<JsonObject>(
    `${baseUrl}/api/runs/${encodeURIComponent(args.runId)}`,
  );
  if (status.status !== 'succeeded' || typeof status.projectId !== 'string' || !status.projectId) {
    // Non-terminal (or terminal-but-failed) status. Surface
    // eventsLogPath with a tail hint so the outer agent can watch live
    // progress in its own shell instead of cancelling because polling
    // shows nothing changing.
    const webBase = await getWebBaseUrl(baseUrl);
    const studioUrl = buildStudioUrl(webBase, status.projectId, status.conversationId, null);
    const enriched: JsonObject = { ...status };
    if (studioUrl) enriched.studioUrl = studioUrl;
    if (typeof status.eventsLogPath === 'string' && status.eventsLogPath.length > 0) {
      enriched.hint = 'Run still in flight. Tail eventsLogPath in your own shell (e.g. `tail -n 50 -f "' + status.eventsLogPath + '"`) to see live text_delta / tool_use events from the inner agent — that is your in-flight progress signal. Keep polling get_run every 30–60s; do not cancel because file mtimes look static, that is the agent thinking between writes.';
      if (studioUrl) {
        enriched.hint += ` Once you have something to show the user, give them a clickable markdown link to studioUrl — render it as \`[Watch progress in Open Design studio](${studioUrl})\`, NEVER as inline code or bare text, so clients like Codex / Cursor / Zed make it navigable in their built-in browser pane.`;
      }
    }
    return ok(enriched);
  }
  const [previewUrl, agentMessage, webBase] = await Promise.all([
    buildRunPreviewUrl(baseUrl, status.projectId),
    fetchRunAgentMessage(baseUrl, String(status.id ?? args.runId)),
    getWebBaseUrl(baseUrl),
  ]);
  // Reverse-derive entryFile from previewUrl when present so we can
  // build a fully-specified studio link (project + conversation +
  // file) rather than just the conversation-level URL.
  const entryFile = previewUrl
    ? decodeURIComponent(previewUrl.split('/raw/')[1] ?? '')
    : null;
  const studioUrl = buildStudioUrl(webBase, status.projectId, status.conversationId, entryFile);
  const enriched: JsonObject = { ...status };
  if (previewUrl) enriched.previewUrl = previewUrl;
  if (agentMessage) enriched.agentMessage = agentMessage;
  if (studioUrl) enriched.studioUrl = studioUrl;
  const parsedForm = agentMessage ? findFirstQuestionForm(agentMessage) : null;
  if (parsedForm) {
    const pending = pendingDiscoveryRuns.get(args.runId);
    const discoveryResponse = await persistDiscoveryFromRun(
      baseUrl,
      args.runId,
      status,
      parsedForm.form,
      pending?.initialRequest ?? (typeof status.currentPrompt === 'string' ? status.currentPrompt : ''),
    );
    pendingDiscoveryRuns.delete(args.runId);
    enriched.questionForm = parsedForm.form;
    enriched.discovery = discoveryResponse;
    enriched.hint = 'This run produced a complete question-form. The daemon has already persisted it as a discovery session. Display discovery.session.form exactly, including every option and recommendation; do not summarize, rewrite, omit, answer, or submit it yourself. Wait for the user to fill it, explicitly accept defaults, or skip. Then call submit_discovery with discovery.session.id and the user\'s explicit action.';
    return ok(enriched);
  }
  if (previewUrl && entryFile) {
    const deliveryValidation = await validateStaticWebDelivery(
      baseUrl,
      status.projectId,
      entryFile,
    );
    enriched.deliveryValidation = deliveryValidation;
    if (deliveryValidation.status === 'incomplete') {
      enriched.daemonStatus = status.status;
      enriched.status = 'incomplete';
      enriched.deliveryStatus = 'incomplete';
      enriched.failureReason = 'DELIVERY_VALIDATION_FAILED';
      enriched.hint = 'The inner agent process exited successfully, but static delivery validation found missing or materially incomplete files. Do not report generation success. Show deliveryValidation.issues to the user and repair or regenerate the project before presenting previewUrl as the deliverable.';
      return ok(enriched);
    }
  }
  if (!previewUrl) {
    if (status.endedWithUnfinishedWork === true) {
      enriched.daemonStatus = status.status;
      enriched.status = 'incomplete';
      enriched.deliveryStatus = 'incomplete';
      enriched.failureReason = 'RUN_ENDED_WITH_UNFINISHED_WORK';
      enriched.hint = 'The inner agent process exited, but Open Design detected unfinished work and no preview file. Do not describe this as a successful generation. Relay agentMessage, report that the delivery is incomplete, and use eventsLogPath to inspect the last tool result. A new generation attempt must start through generate_from_discovery so it uses the persisted brief and a fresh generation conversation; never invent files or call start_run directly.';
      return ok(enriched);
    }
    enriched.hint = 'Run finished but produced no files. Relay agentMessage to the user verbatim. Do not invent a replacement result or start another run unless the user explicitly asks. When studioUrl is present, show it as a clickable markdown link. eventsLogPath, when present, holds the full event log.';
    return ok(enriched);
  }
  enriched.hint = previewUrl
    ? `Run finished. studioUrl (when present) is the BEST link to hand the user — it opens the OD studio page that shows the rendered design AND the chat history (your prompts and the inner agent's replies) side by side. ALWAYS render studioUrl as a clickable markdown link: \`[Open Open Design studio](STUDIO_URL)\` — never as inline code or bare text, because clients like Codex / Cursor / Zed render markdown links as navigable in their built-in browser pane and inline code blocks are not clickable. previewUrl is the raw file URL if the user only wants the rendered output. agentMessage carries the inner agent's explanation; show it alongside the link. Call get_artifact({ project: "${status.projectId}" }) when you need the source files — always pass project explicitly; omitting it falls back to the active project, which may differ. eventsLogPath, when present, holds the full inner-agent event log for forensics.`
    : 'Run finished but produced no files. The inner agent\'s output is in agentMessage — relay it to the user verbatim. Most often this is a clarifying question (e.g. a <question-form>) you should answer by calling start_run again with a more specific prompt or a chosen plugin. When studioUrl is present, show it as a clickable markdown link (`[Open Open Design studio](STUDIO_URL)`) so the user can navigate to the OD page that shows the chat history — never render it as inline code. eventsLogPath, when present, holds the full event log if you need to inspect what happened.';
  return ok(enriched);
}

async function persistDiscoveryFromRun(
  baseUrl: string,
  runId: string,
  status: JsonObject,
  form: unknown,
  initialRequest: string,
): Promise<JsonObject> {
  requireString(status.projectId, 'run projectId');
  const conversationId =
    typeof status.conversationId === 'string' && status.conversationId.length > 0
      ? status.conversationId
      : await getDefaultConversationId(baseUrl, status.projectId);
  requireString(conversationId, 'run conversationId');
  const sessionId = `run-${runId}`;
  try {
    return await postJson<JsonObject>(`${baseUrl}/api/discovery-sessions`, {
      id: sessionId,
      projectId: status.projectId,
      conversationId,
      initialRequest,
      form,
    });
  } catch (error) {
    // get_run may be polled more than once after completion. A deterministic
    // session id keeps persistence idempotent across MCP reconnects.
    try {
      return await getJson<JsonObject>(
        `${baseUrl}/api/discovery-sessions/${encodeURIComponent(sessionId)}`,
      );
    } catch {
      throw error;
    }
  }
}

// Reassemble the inner agent's textual output from the SSE event log.
// We pull the events one-shot (the endpoint returns the full history
// for terminal runs and closes), parse out text_delta deltas, and
// concatenate. Best-effort: any HTTP / parse error returns null so the
// caller just omits the field.
async function fetchRunAgentMessage(baseUrl: string, runId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`);
    if (!resp.ok) return null;
    const body = await resp.text();
    const parts: string[] = [];
    for (const block of body.split(/\n\n/)) {
      if (!block.trim()) continue;
      let eventName = '';
      let dataLine = '';
      for (const rawLine of block.split('\n')) {
        if (rawLine.startsWith('event:')) eventName = rawLine.slice(6).trim();
        else if (rawLine.startsWith('data:')) dataLine = rawLine.slice(5).trim();
      }
      if (eventName !== 'agent' || !dataLine) continue;
      try {
        const data = JSON.parse(dataLine) as { type?: string; delta?: unknown };
        if (data?.type === 'text_delta' && typeof data.delta === 'string') {
          parts.push(data.delta);
        }
      } catch {
        // Non-JSON data lines (rare) are skipped silently.
      }
    }
    const message = parts.join('');
    return message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

// Studio deep links (browser-facing OD page that shows the file
// preview alongside the conversation history for a run). Built from
// the daemon's advertised webBaseUrl + project + conversation + entry
// file. The webBaseUrl is exposed by /api/mcp/install-info; we cache
// it briefly because each get_run/get_project poll otherwise pays for
// an extra fetch. Returns null when any required piece is missing —
// callers omit the field rather than emit a half-built URL.

interface WebBaseUrlCache {
  t: number;
  url: string | null;
}
const WEB_BASE_URL_TTL_MS = 5_000;
let webBaseUrlCache: WebBaseUrlCache | null = null;

// Internal — for tests only. Module-scoped caches persist across `it`
// blocks inside the same vitest module load, so an earlier test that
// returns `null` would otherwise poison subsequent tests for 5s. Test
// files call this in afterEach to start each case with a clean cache.
export function _resetWebBaseUrlCache(): void {
  webBaseUrlCache = null;
}

async function getWebBaseUrl(daemonBaseUrl: string): Promise<string | null> {
  const now = Date.now();
  if (webBaseUrlCache && now - webBaseUrlCache.t < WEB_BASE_URL_TTL_MS) {
    return webBaseUrlCache.url;
  }
  try {
    const data = await getJson<{ webBaseUrl?: string | null }>(
      `${daemonBaseUrl}/api/mcp/install-info`,
    );
    const url =
      typeof data?.webBaseUrl === 'string' && data.webBaseUrl.length > 0
        ? data.webBaseUrl
        : null;
    webBaseUrlCache = { t: now, url };
    return url;
  } catch {
    webBaseUrlCache = { t: now, url: null };
    return null;
  }
}

function buildStudioUrl(
  webBaseUrl: string | null,
  projectId: unknown,
  conversationId: unknown,
  entryFile: unknown,
): string | null {
  if (!webBaseUrl) return null;
  if (typeof projectId !== 'string' || !projectId) return null;
  if (typeof conversationId !== 'string' || !conversationId) return null;
  const base = `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  if (typeof entryFile === 'string' && entryFile.length > 0) {
    const segments = entryFile
      .split('/')
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join('/');
    return `${base}/files/${segments}`;
  }
  return base;
}

// For get_project / start_run: pick the project's first / default
// conversation so the studio link lands the user on a coherent page.
// create_project seeds a default conversation per project; this just
// reads the same one back. Returns null on any lookup failure — caller
// omits studioUrl.
async function getDefaultConversationId(baseUrl: string, projectId: string): Promise<string | null> {
  try {
    const data = await getJson<{ conversations?: Array<{ id?: string }> }>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/conversations`,
    );
    const first = Array.isArray(data?.conversations) ? data.conversations[0] : null;
    return typeof first?.id === 'string' && first.id.length > 0 ? first.id : null;
  } catch {
    return null;
  }
}

// Resolve a project's entry file, preferring metadata.entryFile when
// set and falling back to scanning the file list. This matters because
// real-world writes (write_file, half-finished inner-agent runs)
// leave metadata.entryFile null even when a perfectly viewable
// index.html exists at the project root — without the fallback,
// get_project/get_run would silently omit previewUrl and force the
// outer agent to guess a file:// path.
async function resolveProjectEntry(baseUrl: string, projectId: string, declared: unknown): Promise<string | null> {
  if (typeof declared === 'string' && declared.length > 0) return declared;
  try {
    const data = await getJson<{ files?: Array<{ path?: string; name?: string; kind?: string }> }>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/files`,
    );
    const files = data?.files ?? [];
    // index.html wins at any level — the conventional entry signal.
    const indexHtml = files.find((f) => f?.path === 'index.html' || f?.name === 'index.html');
    if (indexHtml?.path) return indexHtml.path;
    // Otherwise: if exactly one .html sits at the project root, that
    // is unambiguous enough to pick. Don't guess past one match.
    const htmlAtRoot = files.filter(
      (f) => typeof f?.path === 'string' && !f.path.includes('/') && f.path.toLowerCase().endsWith('.html'),
    );
    if (htmlAtRoot.length === 1 && htmlAtRoot[0]?.path) return htmlAtRoot[0].path;
    return null;
  } catch {
    return null;
  }
}

// Build the raw URL that renders a project's entry file. The raw route
// serves it with the right Content-Type and resolves sibling
// CSS/JS/img relative to the same dir, so this URL opens directly in a
// browser (HTML entries render; bare JSX entries that rely on
// host-injected React/Babel do not — those still need the Open Design
// UI). Returns null when there's no entry file. Pure: no I/O, so
// get_project can call it from project data it already has.
function rawPreviewUrl(baseUrl: string, projectId: string, entry: unknown): string | null {
  return buildProjectRawFileUrl(baseUrl, projectId, entry);
}

// Best-effort variant for get_run, which only has a projectId: fetch the
// project, then build the URL. Returns null on any lookup failure — the
// run result is still reachable via get_artifact, so this is a
// convenience only.
async function buildRunPreviewUrl(baseUrl: string, projectId: string): Promise<string | null> {
  try {
    const data = await getJson<ProjectPayload>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}`,
    );
    const project = data?.project ?? data;
    const declared = (project as { metadata?: JsonObject } | undefined)?.metadata?.entryFile;
    const entry = await resolveProjectEntry(baseUrl, projectId, declared);
    return rawPreviewUrl(baseUrl, projectId, entry);
  } catch {
    return null;
  }
}

async function createArtifact(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  requireString(args.name, 'name');
  requireString(args.content, 'content');
  if (
    args.artifactManifest !== undefined &&
    (args.artifactManifest === null ||
      typeof args.artifactManifest !== 'object' ||
      Array.isArray(args.artifactManifest))
  ) {
    throw new Error('artifactManifest must be an object');
  }
  const artifactManifest =
    args.artifactManifest
      ? args.artifactManifest
      : undefined;
  const payload = await postCreateArtifactRequest({
    baseUrl,
    projectId: id,
    input: {
      name: args.name,
      content: args.content,
      encoding: args.encoding === 'base64' ? 'base64' : 'utf8',
      ...(artifactManifest === undefined ? {} : { artifactManifest }),
    },
  });
  const result = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as JsonObject)
    : { result: payload };
  return ok(withActiveEcho(result, active, resolved));
}

// Resource description renderers in some MCP UIs collapse whitespace
// poorly; keep our descriptions on a single line so they don't break
// the catalog list layout.
function oneLine(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Short-lived cache for the project list. A typical agent session
// makes several name-based lookups in quick succession; without this
// each one re-fetches /api/projects. The TTL is short so a project
// renamed in the Open Design UI shows up within a few seconds.
const PROJECT_LIST_TTL_MS = 5000;
let projectListCache: ProjectListCache | null = null;

async function fetchProjectList(baseUrl: string): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (
    projectListCache &&
    projectListCache.baseUrl === baseUrl &&
    now - projectListCache.t < PROJECT_LIST_TTL_MS
  ) {
    return projectListCache.list;
  }
  const data = await getJson<ProjectsPayload>(`${baseUrl}/api/projects`);
  const list = Array.isArray(data?.projects) ? data.projects : [];
  projectListCache = { baseUrl, t: now, list };
  return list;
}

// When the agent omits `project`, fall back to whatever the user has
// open in Open Design. Returns the resolved id plus, for echo-back to the
// caller, the active-context payload that was used. Throws a clear
// error when neither is available so the agent can prompt the user
// rather than guessing.
async function resolveProjectArg(baseUrl: string, arg: unknown): Promise<{ id: string; resolved: ResolvedProject | null; active: ActiveContext | null }> {
  if (typeof arg === 'string' && arg.length > 0) {
    const resolved = await resolveProjectId(baseUrl, arg);
    return { id: resolved.id, resolved, active: null };
  }
  let active: ActiveContext;
  try {
    active = await getJson<ActiveContext>(`${baseUrl}/api/active`);
  } catch (err) {
    throw new Error(
      `project arg omitted and active context lookup failed: ${errorMessage(err)}. Pass project="<id-or-name>".`,
    );
  }
  if (!active || active.active === false || !active.projectId) {
    throw new Error(
      'project arg omitted and Open Design has no active project. The active context expires about 5 minutes after the last user interaction with Open Design - the user may need to click into a project to wake it up. Otherwise pass project="<id-or-name>".',
    );
  }
  return { id: active.projectId, resolved: null, active };
}

async function resolveProjectId(baseUrl: string, arg: unknown): Promise<ResolvedProject> {
  if (typeof arg !== 'string' || !arg) {
    throw new Error('project is required (string).');
  }
  if (UUID_RE.test(arg)) return { id: arg, name: arg, source: 'uuid' as const };

  const list = await fetchProjectList(baseUrl);
  if (list.length === 0) {
    throw new Error('no projects on this daemon');
  }

  const lower = arg.toLowerCase();
  const norm = (s: unknown): string =>
    String(s || '')
      .toLowerCase()
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/[\s_-]+/g, '-');
  const target = norm(arg);

  const idMatch = list.find((p) => p.id === arg);
  if (idMatch) return { id: idMatch.id, name: idMatch.name, source: 'id' as const };

  const exact = list.filter((p) => String(p.name || '').toLowerCase() === lower);
  if (exact.length === 1) { const p = exact[0]!; return { id: p.id, name: p.name, source: 'exact' as const }; }

  const slugged = list.filter((p) => norm(p.name) === target);
  if (slugged.length === 1) { const p = slugged[0]!; return { id: p.id, name: p.name, source: 'slug' as const }; }

  const subs = list.filter((p) =>
    String(p.name || '').toLowerCase().includes(lower),
  );
  if (subs.length === 1) { const p = subs[0]!; return { id: p.id, name: p.name, source: 'substring' as const }; }
  if (subs.length > 1) {
    const opts = subs.map((p) => `${p.name} (${p.id})`).join(', ');
    throw new Error(
      `multiple projects match "${arg}": ${opts}. Pass the UUID instead.`,
    );
  }
  throw new Error(`no project matches "${arg}"`);
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`daemon ${resp.status} on ${url}: ${body || resp.statusText}`);
  }
  return (await resp.json()) as T;
}

async function getFile(baseUrl: string, project: string, relPath: string, active: ActiveContext | null, resolved?: ResolvedProject | null, offset = 0, limit = 2000) {
  const segments = String(relPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(project)}/raw/${segments.join('/')}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    return errorResult(
      `daemon ${resp.status} on ${url}: ${body || resp.statusText}`,
    );
  }
  const mime = ((resp.headers.get('content-type') || 'application/octet-stream').split(';')[0] ?? 'application/octet-stream').trim();
  if (!isTextualMime(mime)) {
    return errorResult(
      `file at "${relPath}" has mime "${mime}"; binary content is not yet supported by od mcp. Use list_files to inspect its metadata.`,
    );
  }
  const text = await resp.text();
  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const start = Math.min(offset, totalLines);
  const slice = allLines.slice(start, start + limit);
  const returnedLines = slice.length;
  const truncated = start + returnedLines < totalLines;

  const extra: string[] = [];
  if (active) extra.push(formatActiveEchoLine(active, relPath));
  if (resolved && (resolved.source === 'slug' || resolved.source === 'substring')) {
    extra.push(`[od:resolved-project id="${resolved.id}" name="${resolved.name}" via="${resolved.source}"]`);
  }
  if (truncated || start > 0) {
    const nextOffset = start + returnedLines;
    const next = truncated ? `; call get_file again with offset=${nextOffset} to read more` : '';
    extra.push(
      `[od:file-window offset=${start} returnedLines=${returnedLines} totalLines=${totalLines}${next}]`,
    );
  }
  return {
    content: [
      ...extra.map((t) => ({ type: 'text', text: t })),
      { type: 'text', text: slice.join('\n') },
    ],
  };
}

// Stamp `usedActiveContext` onto JSON tool responses when the
// project came from /api/active. Plain pass-through when the caller
// supplied project explicitly - keeps token overhead at zero for the
// explicit path.
function withActiveEcho<T extends JsonObject>(payload: T, active: ActiveContext | null, resolved?: ResolvedProject | null): T & JsonObject {
  const result = active ? { ...payload, usedActiveContext: activeEchoPayload(active) } : payload;
  if (resolved && (resolved.source === 'slug' || resolved.source === 'substring')) {
    return { ...result, resolvedProject: { id: resolved.id, name: resolved.name } };
  }
  return result;
}

function activeEchoPayload(active: ActiveContext) {
  return {
    projectId: active.projectId,
    projectName: active.projectName ?? null,
    fileName: active.fileName ?? null,
    ageMs: active.ageMs ?? null,
  };
}

function formatActiveEchoLine(active: ActiveContext, resolvedPath: string): string {
  const proj = active.projectName || active.projectId;
  const note = `[od:active-context project="${proj}" file="${resolvedPath}"]`;
  return active.fileName === resolvedPath
    ? note
    : `${note} (active file: ${active.fileName ?? 'none'})`;
}

const VALID_INCLUDE_MODES = new Set(['auto', 'all', 'shallow']);
const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_FILES = 200;

// Tracks total textual content bytes accumulated; binary stubs don't
// count (their content is null). Once we cross the cap the caller
// stops fetching and stamps `truncated: true` on the bundle.
function totalTextBytes(files: ProjectFileBundleEntry[]): number {
  let n = 0;
  for (const f of files) {
    if (!f.binary && typeof f.content === 'string') n += f.content.length;
  }
  return n;
}

async function getArtifact(baseUrl: string, projectArg: unknown, entryArg: unknown, includeMode: unknown, maxBytesArg: unknown) {
  const include = includeMode == null || includeMode === '' ? 'auto' : includeMode;
  if (typeof include !== 'string' || !VALID_INCLUDE_MODES.has(include)) {
    return errorResult(
      `invalid include "${includeMode}"; expected one of: auto, all, shallow`,
    );
  }
  const maxBytes =
    typeof maxBytesArg === 'number' && Number.isFinite(maxBytesArg) && maxBytesArg > 0 ? maxBytesArg : DEFAULT_MAX_BYTES;

  const { id, active, resolved } = await resolveProjectArg(baseUrl, projectArg);
  const data = await getJson<ProjectPayload>(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
  const project = (data.project ?? data) as ProjectSummary;
  // Active-file beats project default entry when project also came
  // from active context - if the user is on landing.html and asks
  // "bundle this", they mean landing.html, not whatever
  // metadata.entryFile happens to be.
  const explicitEntry = typeof entryArg === 'string' && entryArg.length > 0;
  const metadataEntry = typeof project.metadata?.entryFile === 'string' ? project.metadata.entryFile : undefined;
  const entry: string | undefined = explicitEntry
    ? String(entryArg)
    : (active && active.fileName) || metadataEntry;
  if (!entry) {
    return errorResult(
      `no entry file: pass entry="..." or set the project's metadata.entryFile`,
    );
  }

  if (include === 'shallow') {
    let file;
    try {
      file = await fetchProjectFile(baseUrl, id, entry);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
    return okBundle({ project, entry, files: [file], truncated: false, active, resolved });
  }

  if (include === 'all') {
    const meta = await getJson<{ files?: Array<{ name: string }> }>(`${baseUrl}/api/projects/${encodeURIComponent(id)}/files`);
    const allFiles = Array.isArray(meta?.files) ? meta.files : [];
    const fetched: ProjectFileBundleEntry[] = [];
    let truncated = false;
    for (const f of allFiles) {
      if (fetched.length >= MAX_FILES || totalTextBytes(fetched) >= maxBytes) {
        truncated = true;
        break;
      }
      try {
        const remaining = maxBytes - totalTextBytes(fetched);
        fetched.push(await fetchProjectFile(baseUrl, id, f.name, remaining));
      } catch (err) {
        if (err instanceof BudgetExceededError) truncated = true;
        // Skip files that fail to fetch; keep going.
      }
    }
    return okBundle({ project, entry, files: fetched, truncated, active, resolved });
  }

  // Auto mode: BFS from entry. The entry's own fetch must succeed - 
  // a 404 there almost always means the agent typo'd `entry:`, and
  // returning an empty bundle would hide that.
  let entryFile;
  try {
    entryFile = await fetchProjectFile(baseUrl, id, entry);
  } catch (err) {
    return errorResult(errorMessage(err));
  }
  const MAX_DEPTH = 3;
  const visited = new Set([entry]);
  const fetched = [entryFile];
  let truncated = false;
  let frontier: string[] = [];
  if (isTextualMime(entryFile.mime)) {
    frontier = extractRelativeRefs(entryFile.content || '', entry, entryFile.mime).filter(
      (r) => !visited.has(r),
    );
  }
  outer: for (let depth = 1; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const refPath of frontier) {
      if (visited.has(refPath)) continue;
      visited.add(refPath);
      if (fetched.length >= MAX_FILES || totalTextBytes(fetched) >= maxBytes) {
        truncated = true;
        break outer;
      }
      let file;
      try {
        const remaining = maxBytes - totalTextBytes(fetched);
        file = await fetchProjectFile(baseUrl, id, refPath, remaining);
      } catch (err) {
        if (err instanceof BudgetExceededError) truncated = true;
        continue;
      }
      fetched.push(file);
      if (!isTextualMime(file.mime)) continue;
      const refs = extractRelativeRefs(file.content || '', refPath, file.mime);
      for (const ref of refs) {
        if (!visited.has(ref)) next.push(ref);
      }
    }
    frontier = next;
  }
  return okBundle({ project, entry, files: fetched, truncated, active, resolved });
}

// Thrown by fetchProjectFile when the server-advertised content-length exceeds
// the remaining byte budget. Distinguished from generic fetch errors (404,
// network) so callers can set truncated: true without treating it as a hard
// failure of the whole bundle.
class BudgetExceededError extends Error {}

async function fetchProjectFile(baseUrl: string, projectId: string, relPath: string, remainingBytes = Infinity): Promise<ProjectFileBundleEntry> {
  const segments = String(relPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/raw/${segments.join('/')}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`daemon ${resp.status} on ${url}: ${body || resp.statusText}`);
  }
  const mime = ((resp.headers.get('content-type') || 'application/octet-stream').split(';')[0] ?? 'application/octet-stream').trim();
  const headerSize = Number(resp.headers.get('content-length'));
  const size = Number.isFinite(headerSize) && headerSize >= 0 ? headerSize : null;
  if (!isTextualMime(mime)) {
    return { name: relPath, mime, size, content: null, binary: true };
  }
  // If the server advertises a size that already exceeds our remaining
  // budget, skip reading the body to avoid a large allocation.
  if (size !== null && size > remainingBytes) {
    throw new BudgetExceededError(`file ${relPath} (${size} bytes) exceeds remaining budget`);
  }
  const content = await resp.text();
  return { name: relPath, mime, size: size ?? content.length, content, binary: false };
}

// Patterns common to HTML and CSS (also fine to run on plain markdown).
const HTML_REF_PATTERNS = [
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<video\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<audio\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi,
];

const CSS_REF_PATTERNS = [
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
];

// JS/TS only - running these on prose creates false positives on words
// like "imported from 'X'".
const JS_REF_PATTERNS = [
  /\bimport\s+[^'"]*?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// `srcset` can list multiple comma-separated candidates.
const SRCSET_PATTERN = /\bsrcset=["']([^"']+)["']/gi;

function isJsLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /javascript|typescript/i.test(mime)) return true;
  return /\.(?:m?jsx?|tsx?|cjs)$/i.test(fromPath);
}

function isCssLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /^text\/css\b/i.test(mime)) return true;
  return /\.css$/i.test(fromPath);
}

function isHtmlLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /^text\/html\b/i.test(mime)) return true;
  return /\.html?$/i.test(fromPath);
}

function extractRelativeRefs(text: string, fromPath: string, fromMime: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  const runPatterns: RegExp[] = [];
  if (isHtmlLike(fromMime, fromPath)) {
    runPatterns.push(...HTML_REF_PATTERNS, ...CSS_REF_PATTERNS);
  }
  if (isCssLike(fromMime, fromPath)) {
    runPatterns.push(...CSS_REF_PATTERNS);
  }
  if (isJsLike(fromMime, fromPath)) {
    runPatterns.push(...JS_REF_PATTERNS);
  }
  // Fallback for unknown textual files: only the safest pattern,
  // url() in case it's a CSS-in-something we don't recognize.
  if (runPatterns.length === 0) {
    runPatterns.push(...CSS_REF_PATTERNS);
  }

  const candidates: string[] = [];
  for (const re of runPatterns) {
    for (const m of text.matchAll(re)) {
      const ref = (m[1] || '').trim();
      if (ref) candidates.push(ref);
    }
  }
  // Pull every candidate URL out of any srcset attributes in HTML.
  if (isHtmlLike(fromMime, fromPath)) {
    for (const m of text.matchAll(SRCSET_PATTERN)) {
      const list = m[1] || '';
      for (const part of list.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) candidates.push(url);
      }
    }
  }

  for (const raw of candidates) {
    if (/^(?:https?:|\/\/|data:|mailto:|tel:|#)/i.test(raw)) continue;
    const dir = fromPath.includes('/')
      ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1)
      : '';
    const resolved = raw.startsWith('/') ? raw.slice(1) : dir + raw;
    const stripped = resolved.replace(/[?#].*$/, '');
    const segs = stripped.split('/').filter(Boolean);
    const out: string[] = [];
    let escaped = false;
    for (const s of segs) {
      if (s === '.') continue;
      if (s === '..') {
        if (out.length === 0) { escaped = true; break; }
        out.pop();
        continue;
      }
      out.push(s);
    }
    if (escaped || out.length === 0) continue;
    refs.add(out.join('/'));
  }
  return [...refs];
}

function okBundle(bundle: BundleInput) {
  const payload = {
    entryFile: bundle.entry,
    projectId: bundle.project?.id,
    projectName: bundle.project?.name,
    truncated: bundle.truncated === true,
    files: bundle.files.map((f) => ({
      name: f.name,
      mime: f.mime,
      size: f.size,
      binary: f.binary === true,
      content: f.binary ? null : f.content,
    })),
    manifest: bundle.project?.metadata ?? null,
  };
  return ok(withActiveEcho(payload, bundle.active, bundle.resolved));
}

function isTextualMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return TEXTUAL_MIME_PATTERNS.some((re) => re.test(mime));
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function formatError(err: unknown, daemonUrl: string): string {
  const e = err as ErrorWithCode | null | undefined;
  const code = e && (e.cause?.code || e.code);
  const msg = errorMessage(err);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return `cannot reach the Open Design daemon at ${daemonUrl}. Is it running? Start it with \`pnpm tools-dev\`.`;
  }
  return msg;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exported for unit tests only.
export { extractRelativeRefs, resolveProjectId, resolveProjectArg, withActiveEcho, fetchProjectFile, getArtifact, getFile, createArtifact, handleMcpToolCall };
