import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("discovery tools (read-only, company-scoped)", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret; });

  const rpc = async (token: string | null, method: string, params?: unknown) => {
    const res = await fetch(`${server.apiUrl}/api/mcp/discovery-tools`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: res.status === 202 ? null : await res.json() };
  };

  it("lists the read-only discovery tools", async () => {
    const f = await server.fixture({});
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const { body } = await rpc(token, "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["pending_approvals", "read_task", "search_tasks"]);
  });

  it("searches tasks assigned to the agent without any issue context", async () => {
    const f = await server.fixture({});
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const { body } = await rpc(token, "tools/call", { name: "search_tasks", arguments: { assigneeAgentId: f.agentId } });
    const result = body.result.structuredContent;
    const ids = result.tasks.map((t: { id: string }) => t.id);
    // The fixture's todo blocker is assigned to the agent and must be discoverable.
    expect(ids).toContain(f.blockerId);
    for (const t of result.tasks) expect(t.companyId).toBe(f.companyId);
  });

  it("reads one task with its recent comments", async () => {
    const f = await server.fixture({});
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const { body } = await rpc(token, "tools/call", { name: "read_task", arguments: { taskId: f.blockerId } });
    const result = body.result.structuredContent;
    expect(result.task.id).toBe(f.blockerId);
    expect(Array.isArray(result.comments)).toBe(true);
  });

  it("lists pending approvals", async () => {
    const f = await server.fixture({});
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const { body } = await rpc(token, "tools/call", { name: "pending_approvals", arguments: {} });
    const result = body.result.structuredContent;
    expect(result.approvals.some((a: { id: string }) => a.id === f.approvalId)).toBe(true);
  });

  it("rejects an unauthenticated call", async () => {
    await server.fixture({});
    const { body } = await rpc(null, "tools/call", { name: "search_tasks", arguments: {} });
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });

  it("does not leak another company's tasks", async () => {
    const f = await server.fixture({});
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const { body } = await rpc(token, "tools/call", { name: "read_task", arguments: { taskId: f.foreignProjectId } });
    // foreignProjectId is a project id in another company; not a readable task here.
    expect(body.result.isError).toBe(true);
  });
});
