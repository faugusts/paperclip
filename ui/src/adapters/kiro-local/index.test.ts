import { describe, expect, it } from "vitest";
import { getUIAdapter, syncExternalAdapters } from "../registry";
import { buildTranscript } from "../transcript";
import { kiroLocalUIAdapter } from "./index";

// Linhas reais do protocolo ACPX emitidas por um run kiro_local em produção
// (envelope já desembrulhado: o conteúdo interno de cada chunk stdout).
const SESSION = JSON.stringify({
  type: "acpx.session",
  agent: "inti-software-architect",
  sessionId: "319e9431",
  acpSessionId: "319e9431",
  mode: "default",
});
const TEXT_DELTA = JSON.stringify({
  type: "acpx.text_delta",
  text: "Analisando a arquitetura",
  channel: "output",
});
const TOOL_CALL = JSON.stringify({
  type: "acpx.tool_call",
  name: "set_task_title",
  toolCallId: "tooluse_abc",
  status: "completed",
  input: {},
});

describe("kiro_local builtin UI adapter", () => {
  it("é resolvido como builtin síncrono (sem bridge dinâmico)", () => {
    const adapter = getUIAdapter("kiro_local");
    expect(adapter.type).toBe("kiro_local");
    expect(adapter).toBe(kiroLocalUIAdapter);
  });

  it("parseia acpx.text_delta em entry assistant (activity visível)", () => {
    const entries = getUIAdapter("kiro_local").parseStdoutLine(TEXT_DELTA, "2026-10-18T15:18:08.353Z");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("assistant");
    expect((entries[0] as { text: string }).text).toContain("Analisando a arquitetura");
  });

  it("buildTranscript produz activity a partir dos eventos reais do kiro", () => {
    const chunks = [SESSION, TEXT_DELTA, TOOL_CALL].map((line, i) => ({
      ts: `2026-10-18T15:18:0${i}.000Z`,
      stream: "stdout" as const,
      chunk: line + "\n",
      seq: i + 1,
    }));
    const transcript = buildTranscript(chunks, getUIAdapter("kiro_local"));
    const kinds = transcript.map((e) => e.kind);
    // init (session) + assistant (text_delta) + tool_call — nada vira "stdout" cru.
    expect(kinds).toContain("init");
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("tool_call");
    expect(kinds).not.toContain("stdout");
  });

  it("NÃO é sobrescrito quando o servidor lista kiro_local como external adapter", () => {
    // Regressão: kiro_local é builtin com o parser ACPX canônico. Se o server o
    // lista como external (com ui-parser.js), o override NÃO pode trocar o
    // builtin pelo bridge do dynamic-loader (Web Worker), que regride o activity.
    syncExternalAdapters([{ type: "kiro_local", label: "Kiro" }]);
    try {
      const adapter = getUIAdapter("kiro_local");
      expect(adapter).toBe(kiroLocalUIAdapter);
      // E continua parseando acpx síncrono (não virou bridge que retorna []).
      const entries = adapter.parseStdoutLine(TEXT_DELTA, "2026-10-18T15:18:08.353Z");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.kind).toBe("assistant");
    } finally {
      syncExternalAdapters([]);
    }
  });
});
