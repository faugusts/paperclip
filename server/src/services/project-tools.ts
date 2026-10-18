import { projectDiscoverySchema, createProjectSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];

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
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && ["create_task", "set_task_title"].includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.operationId === "create_task"
        ? withCreateTaskGovernance(tool.inputSchema)
        : tool.inputSchema,
  }));
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  const page = input.name === "list_projects" ? projectDiscoverySchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
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
    method: input.name === "set_task_title" ? "PUT" : body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return result;
}
