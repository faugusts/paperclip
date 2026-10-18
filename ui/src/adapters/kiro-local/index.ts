import type { UIAdapterModule } from "../types";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

// `kiro_local` é um adapter externo (process) que emite o protocolo ACPX
// canônico — os mesmos eventos acpx.session / acpx.text_delta / acpx.tool_call /
// acpx.tool_result / acpx.status / acpx.result que o codex_local emite.
//
// Registrá-lo como UI adapter BUILTIN usando o parser ACPX canônico
// (`parseAcpxStdoutLine`, o mesmo motor do codex) faz o activity do kiro ser
// renderizado de forma SÍNCRONA, sem depender do carregamento do ui-parser.js
// dinâmico num Web Worker — caminho que não dispara/falha de forma confiável
// em produção atrás do Cloudflare Access.
//
// Se o servidor servir um ui-parser.js externo para "kiro_local", o mecanismo
// de override de builtin (syncExternalAdapters) ainda pode substituir este
// parser pelo dinâmico; enquanto o dinâmico não carrega, este builtin garante
// o fallback funcional (em vez do process genérico, que descarta o acpx).
export const kiroLocalUIAdapter: UIAdapterModule = {
  type: "kiro_local",
  label: "Kiro",
  parseStdoutLine: parseAcpxStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
