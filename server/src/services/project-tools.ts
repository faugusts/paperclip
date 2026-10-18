import { projectDiscoverySchema, createProjectSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];

// Durable deliverable persistence. The execution workspace is ephemeral — files
// written with the native file tool (e.g. /tmp/report.md) are destroyed on run
// teardown and never reach the task. This tool writes a document straight to the
// current task via the authenticated API (PUT /issues/:id/documents/:key) using
// the run's own Bearer token, so no new credential is introduced. Mirrors the
// REST route's upsertIssueDocumentSchema (key slug + title/format/body).
const WRITE_DOCUMENT_TOOL = {
  name: "write_document",
  description:
    "Persist a durable deliverable document on the CURRENT task so it survives after this run ends. The execution workspace is ephemeral: files you write to disk (e.g. /tmp/report.md) are discarded on teardown and are NOT saved to the task. Use this tool to store any report, analysis, plan, or discovery you produce. Call it with a short key (lowercase slug), a title, and the full markdown body. Re-calling with the same key updates that document.",
  inputSchema: {
    type: "object",
    required: ["key", "body"],
    properties: {
      key: {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9_-]*$",
        maxLength: 64,
        description: "Short lowercase slug identifying the document (e.g. \"discovery\", \"report\", \"plan\"). Reusing a key overwrites that document.",
      },
      title: { type: "string", maxLength: 200, description: "Human-readable document title." },
      body: { type: "string", maxLength: 524288, description: "Full document content in Markdown." },
      changeSummary: { type: "string", maxLength: 500, description: "Optional one-line summary of this revision." },
    },
  },
} as const;

// Governance fields injected into the create_task tool schema so a delegating
// agent (CEO/Tech Lead) can attach runtime-enforced review/approval/watchdog
// when it delegates — mirrors paperclip_create_task (public MCP). The vendored
// semantic catalog schema does not carry these, so we merge them into the
// exposed JSON Schema here and translate them to executionPolicy/watchdog in
// callProjectTool below.
const CREATE_TASK_GOVERNANCE_PROPERTIES = {
  reviewerAgentId: { type: "string", description: "Agent UUID that must review (approve/request changes) before this task reaches done. Runtime-enforced review stage. Do not set the assignee as its own reviewer." },
  approverUserId: { type: "string", description: "Board user UUID that must give final sign-off after review. Use for sensitive/irreversible work (auth, RLS, minor data, structural irreversibilities)." },
  watchdogAgentId: { type: "string", description: "Agent UUID that watches this task's subtree and is woken to act if it stalls. Do not set the assignee as its own watchdog." },
  watchdogInstructions: { type: "string", description: "Optional instructions for the watchdog agent." },
} as const;

function withCreateTaskGovernance(inputSchema: unknown): unknown {
  const schema = (inputSchema && typeof inputSchema === "object") ? inputSchema as Record<string, unknown> : { type: "object" };
  const props = (schema.properties && typeof schema.properties === "object") ? schema.properties as Record<string, unknown> : {};
  return { ...schema, properties: { ...props, ...CREATE_TASK_GOVERNANCE_PROPERTIES } };
}

export function projectToolDefinitions(workMode: string, includeTask = false) {
  const base = CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && ["create_task", "set_task_title"].includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.operationId === "create_task"
        ? withCreateTaskGovernance(tool.inputSchema)
        : tool.inputSchema,
  }));
  // write_document is a locally-declared, task-scoped tool (not in the vendored
  // semantic catalog). Exposed alongside the other task tools so a running agent
  // can persist deliverables durably instead of losing them to the ephemeral fs.
  if (includeTask) base.push({ name: WRITE_DOCUMENT_TOOL.name, description: WRITE_DOCUMENT_TOOL.description, inputSchema: WRITE_DOCUMENT_TOOL.inputSchema });
  return base;
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  if (input.name === "write_document") {
    const key = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(64).parse(String(args.key ?? "").trim().toLowerCase());
    const docPath = `/issues/${input.issueId}/documents/${key}`;
    const apiBase = `${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api`;
    // Updating an existing document requires the current latestRevisionId for
    // optimistic concurrency. Fetch it transparently so the agent can simply
    // call write_document with key+body (and re-call to overwrite) without a
    // manual GET-then-PUT handshake. A missing document (404) means create.
    let baseRevisionId: string | null = null;
    const existing = await fetch(`${apiBase}${docPath}`, {
      method: "GET", headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(60_000),
    });
    if (existing.ok) {
      const current = await existing.json().catch(() => null);
      const rev = current && typeof current === "object" ? (current.latestRevisionId ?? current.document?.latestRevisionId) : null;
      if (typeof rev === "string") baseRevisionId = rev;
    }
    const put = await fetch(`${apiBase}${docPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: typeof args.title === "string" ? args.title : null,
        format: "markdown",
        body: z.string().max(524288).parse(args.body),
        ...(baseRevisionId ? { baseRevisionId } : {}),
        ...(typeof args.changeSummary === "string" ? { changeSummary: args.changeSummary } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const putResult = await put.json();
    if (!put.ok) throw new Error(typeof putResult.error === "string" ? putResult.error : `write_document failed (${put.status})`);
    return putResult;
  }
  const page = input.name === "list_projects" ? projectDiscoverySchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  let method: "GET" | "POST" | "PUT" = "POST";
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
    method = "PUT";
    body = setIssueTitleSchema.parse(args);
  } else if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (page) {
    const query = new URLSearchParams({ view: "summary", limit: String(page.limit) });
    if (page.cursor) query.set("cursor", page.cursor);
    path += `?${query}`;
  }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    // Optional governance (mirrors paperclip_create_task): translate the
    // high-level fields into a runtime-enforced executionPolicy + watchdog.
    // Review stage precedes approval (review -> approval -> done). The runtime
    // excludes the executor from reviewing/approving its own work.
    const reviewerAgentId = typeof args.reviewerAgentId === "string" ? args.reviewerAgentId : undefined;
    const approverUserId = typeof args.approverUserId === "string" ? args.approverUserId : undefined;
    const watchdogAgentId = typeof args.watchdogAgentId === "string" ? args.watchdogAgentId : undefined;
    const watchdogInstructions = typeof args.watchdogInstructions === "string" ? args.watchdogInstructions : undefined;
    const stages: Array<{ type: "review" | "approval"; participants: Array<{ type: "agent" | "user"; agentId?: string; userId?: string }> }> = [];
    if (reviewerAgentId) stages.push({ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] });
    if (approverUserId) stages.push({ type: "approval", participants: [{ type: "user", userId: approverUserId }] });
    const executionPolicy = stages.length > 0 ? { mode: "normal", commentRequired: true, stages } : undefined;
    const watchdog = watchdogAgentId
      ? { agentId: watchdogAgentId, ...(watchdogInstructions ? { instructions: watchdogInstructions } : {}) }
      : undefined;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      ...(executionPolicy ? { executionPolicy } : {}),
      ...(watchdog ? { watchdog } : {}),
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: method === "PUT" ? "PUT" : body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return result;
}
