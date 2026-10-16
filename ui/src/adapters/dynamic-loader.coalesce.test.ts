// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDynamicParserResultNotifier,
  scheduleResultNotificationForTest,
  flushDynamicParserNotificationsForTest,
} from "./dynamic-loader";

/**
 * Regressão do fix de coalescência: o parser dinâmico resolve UMA resposta do
 * worker POR LINHA e cada resolução agenda uma notificação. Sem coalescência,
 * um burst de N linhas gerava N ticks (N recomputações de transcript). Com o
 * fix, um burst dentro do mesmo frame vira UM único flush.
 */
describe("dynamic-loader: coalescência de notificações do parser", () => {
  let rafQueue: FrameRequestCallback[];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafQueue = [];
    // rAF controlado: enfileira; o teste decide quando "pintar o frame".
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
    setDynamicParserResultNotifier(null);
    flushDynamicParserNotificationsForTest();
  });

  function paintFrame() {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(performance.now());
  }

  it("colapsa um burst de N resoluções em UM único tick", () => {
    const notify = vi.fn();
    setDynamicParserResultNotifier(notify);

    // Simula 50 linhas resolvendo no mesmo frame.
    for (let i = 0; i < 50; i++) scheduleResultNotificationForTest();

    // Antes de pintar o frame, nenhuma notificação disparou.
    expect(notify).toHaveBeenCalledTimes(0);
    // Apenas UM rAF foi agendado para o burst inteiro.
    expect(rafQueue.length).toBe(1);

    paintFrame();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("permite um novo tick após o frame anterior ter drenado", () => {
    const notify = vi.fn();
    setDynamicParserResultNotifier(notify);

    scheduleResultNotificationForTest();
    paintFrame();
    expect(notify).toHaveBeenCalledTimes(1);

    // Nova rodada de linhas após o flush → novo tick (não fica preso).
    scheduleResultNotificationForTest();
    scheduleResultNotificationForTest();
    paintFrame();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
