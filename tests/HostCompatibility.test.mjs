import test from "node:test";
import assert from "node:assert/strict";
import { createHostCompatibility } from "../modules/HostCompatibility.js";

test("legacy generation and swipe guards read live core state without missing named exports", () => {
  const core = { CLIENT_VERSION: "SillyTavern:1.14.0:Cohee#1207", is_send_press: false, isSwipingAllowed: true };
  const host = createHostCompatibility(core);
  assert.equal(host.legacy(), true);
  assert.equal(host.isGenerating(), false);
  core.is_send_press = true; core.isSwipingAllowed = false;
  assert.equal(host.isGenerating(), true);
  assert.equal(host.isSwiping(), true);
  core.CLIENT_VERSION = "SillyTavern:1.17.0:Cohee#1207";
  core.isGenerating = () => true; core.swipeState = "none";
  assert.equal(host.legacy(), false);
  assert.equal(host.isGenerating(), true);
  assert.equal(host.isSwiping(), false);
});

test("legacy selection updates only the supplied reply snapshot and preserves reply metadata", () => {
  const core = { CLIENT_VERSION: "SillyTavern:1.16.0:Cohee#1207", syncSwipeToMes() { throw Error("old core would select the live reply"); } };
  const host = createHostCompatibility(core);
  const source = { mes: "A", swipe_id: 0, swipes: ["A", "B"], swipe_info: [{ extra: { memory: "A" } },
    { send_date: "B-date", gen_started: 1, gen_finished: 2, extra: { memory: "B" } }], extra: { memory: "A" }, foreign: [1] };
  const copy = structuredClone(source);
  assert.equal(host.selectSwipe(copy, 1), true);
  assert.equal(source.mes, "A");
  assert.equal(copy.mes, "B");
  assert.equal(copy.swipe_id, 1);
  assert.deepEqual(copy.extra, { memory: "B" });
  assert.equal(copy.send_date, "B-date");
  assert.deepEqual(copy.foreign, [1]);
  copy.extra.memory = "edited";
  assert.equal(copy.swipe_info[1].extra.memory, "B");
  assert.equal(host.selectSwipe(copy, 5), false);
});

test("modern core keeps its native selection; unknown core never probes a live selector", () => {
  let calls = 0;
  const core = { CLIENT_VERSION: "SillyTavern:1.18.0:Cohee#1207", syncSwipeToMes(id, swipe, message) { calls++; assert.equal(id, null); message.mes = message.swipes[swipe]; return true; } };
  const host = createHostCompatibility(core), message = { swipes: ["A", "B"] };
  assert.equal(host.selectSwipe(message, 1), true);
  assert.equal(calls, 1);
  core.CLIENT_VERSION = "SillyTavern:UNKNOWN:Cohee#1207";
  assert.equal(host.legacy(), false);
  assert.equal(host.selectSwipe(message, 0), true);
  assert.equal(calls, 1);
});

test("legacy native files use unique route names and the original core serializer", async () => {
  const calls = [];
  const host = createHostCompatibility({ CLIENT_VERSION: "SillyTavern:1.14.0:Cohee#1207", saveChat: async options => calls.push(options) });
  const ctx = { chatId: "source", chat: [{ mes: "source text" }] };
  const first = await host.createLegacyBranch(0, "route-a", ctx);
  const second = await host.createLegacyBranch(0, "route-b", ctx);
  assert.notEqual(first, second);
  assert.deepEqual(calls, [
    { chatName: first, withMetadata: { main_chat: "source" }, mesId: 0 },
    { chatName: second, withMetadata: { main_chat: "source" }, mesId: 0 },
  ]);
  assert.equal(ctx.chat[0].mes, "source text");
  await assert.rejects(host.createLegacyBranch(0, "../unsafe", ctx), /参数无效/);
  await assert.rejects(host.createLegacyBranch(0, undefined, ctx), /参数无效/);
});
