// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

// Reproduz o caso real do kiro_local (INT-35): run LEGACY SUCCEEDED, terminal,
// com log persistido (logBytes>0) e SEM hasStoredOutput vindo do backend. O log
// é NDJSON de envelopes { ts, stream, chunk, seq } cujo `chunk` é JSON acpx.*.
// Objetivo: provar (a) que o log terminal é lido e vira transcript, e (b) que
// hasOutputForRun é verdadeiro para esse run mesmo antes/apesar do backend não
// mandar hasStoredOutput.

const REAL_CONTENT =
  '{"ts":"2026-10-16T02:36:37.333Z","stream":"stdout","chunk":"{\\"type\\":\\"acpx.session\\",\\"agent\\":\\"inti-software-engineer\\",\\"mode\\":\\"kiro_local\\"}\\n","seq":1}\n' +
  '{"ts":"2026-10-16T02:36:42.119Z","stream":"stdout","chunk":"{\\"type\\":\\"acpx.tool_call\\",\\"name\\":\\"set_task_title\\",\\"toolCallId\\":\\"t1\\",\\"status\\":\\"completed\\",\\"input\\":{}}\\n","seq":2}\n' +
  '{"ts":"2026-10-16T02:36:44.086Z","stream":"stdout","chunk":"{\\"type\\":\\"acpx.text_delta\\",\\"text\\":\\"Oi\\",\\"channel\\":\\"output\\"}\\n","seq":3}\n';

const { useQueryMock, logMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(() => ({ data: { censorUsernameInLogs: false } })),
  logMock: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("../../api/instanceSettings", () => ({ instanceSettingsApi: { getGeneral: vi.fn() } }));
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { log: logMock } }));

// Parser kiro_local real (subset) + buildTranscript real seria o ideal, mas aqui
// basta um adapter que converte cada linha acpx.* em uma entry — o foco é a
// LEITURA do log terminal e o hasOutputForRun, não o parsing (já provado em repro).
vi.mock("../../adapters", async () => {
  const actual = await vi.importActual<typeof import("../../adapters")>("../../adapters");
  return {
    ...actual,
    getUIAdapter: () => ({
      type: "kiro_local",
      label: "kiro_local",
      parseStdoutLine: (line: string, ts: string) => {
        try {
          const o = JSON.parse(line);
          if (typeof o?.type === "string" && o.type.startsWith("acpx.")) {
            return [{ kind: "system", ts, text: o.type }];
          }
        } catch { /* noop */ }
        return [{ kind: "stdout", ts, text: line }];
      },
    }),
    onAdapterChange: () => () => {},
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveRunTranscripts — kiro_local terminal run (INT-35 repro)", () => {
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    useQueryMock.mockClear();
    logMock.mockReset();
    // Primeira leitura devolve o conteúdo; leituras seguintes, vazio (sem nextOffset).
    logMock.mockImplementation(async () => ({
      runId: "run-kiro", store: "local_file", logRef: "x.ndjson",
      content: REAL_CONTENT, nextOffset: undefined,
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("lê o log de um run SUCCEEDED terminal e expõe output (sem hasStoredOutput do backend)", async () => {
    const runs = [{
      id: "run-kiro",
      status: "succeeded",            // terminal
      adapterType: "kiro_local",
      runtimeMode: "legacy" as const,
      logBytes: 27900,                // backend manda logBytes, NÃO hasStoredOutput
      // hasStoredOutput: undefined   // <- exatamente o caso real
    }];

    let api: ReturnType<typeof useLiveRunTranscripts> | null = null;
    function Harness() {
      api = useLiveRunTranscripts({ companyId: "c1", runs, enableRealtimeUpdates: false });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    // deixa o readAll assíncrono resolver
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(logMock).toHaveBeenCalled();                       // o terminal FOI lido
    expect(api).not.toBeNull();
    const transcript = api!.transcriptByRun.get("run-kiro") ?? [];
    // deve ter 3 entries (session, tool_call, text_delta)
    expect(transcript.length).toBeGreaterThan(0);
    // e o run deve contar como "tem output" para o gate do chat
    expect(api!.hasOutputForRun("run-kiro")).toBe(true);

    root.unmount();
  });

  it("hasOutputForRun é true por logBytes mesmo ANTES de qualquer leitura de log", async () => {
    // Simula o instante inicial: nenhuma leitura resolveu ainda (log pendura).
    logMock.mockImplementation(() => new Promise(() => {})); // nunca resolve
    const runs = [{
      id: "run-kiro2",
      status: "succeeded" as const,
      adapterType: "kiro_local",
      runtimeMode: "legacy" as const,
      logBytes: 27900,
    }];
    let api: ReturnType<typeof useLiveRunTranscripts> | null = null;
    function Harness() {
      api = useLiveRunTranscripts({ companyId: "c1", runs, enableRealtimeUpdates: false });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await Promise.resolve(); });

    // chunksByRun vazio (log não resolveu), mas logBytes>0 ⇒ hasOutputForRun true.
    expect(api!.hasOutputForRun("run-kiro2")).toBe(true);
    root.unmount();
  });
});
