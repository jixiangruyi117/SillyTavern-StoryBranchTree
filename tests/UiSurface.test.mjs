import test from "node:test";
import assert from "node:assert/strict";
import { dismissOnBackdrop } from "../modules/UiSurface.js";

function backdrop() {
  const overlay = new EventTarget(), card = {};
  let dismissed = 0;
  dismissOnBackdrop(overlay, () => dismissed++);
  const send = (type, target = overlay, options = {}) => {
    const event = new Event(type);
    Object.defineProperties(event, Object.fromEntries(Object.entries({
      target, pointerId: 0, button: 0, isPrimary: true, ...options,
    }).map(([key, value]) => [key, { value }])));
    overlay.dispatchEvent(event);
  };
  return { overlay, card, send, count: () => dismissed };
}

test("backdrop closes once after a complete primary click, including pointer ID zero", () => {
  const b = backdrop();
  b.send("pointerdown"); b.send("pointerup"); b.send("click"); b.send("click");
  assert.equal(b.count(), 1);
});

test("dragging out of or into a dialog does not discard its contents", () => {
  const b = backdrop();
  b.send("pointerdown", b.card); b.send("pointerup"); b.send("click");
  b.send("pointerdown"); b.send("pointerup", b.card); b.send("click");
  assert.equal(b.count(), 0);
  b.send("pointerdown"); b.send("pointerup"); b.send("click");
  assert.equal(b.count(), 1);
});

test("cancelled touch gestures and another pointer cannot dismiss a dialog", () => {
  const b = backdrop();
  b.send("pointerdown"); b.send("pointercancel"); b.send("pointerup"); b.send("click");
  b.send("pointerdown"); b.send("pointerup", b.overlay, { pointerId: 2 }); b.send("click");
  assert.equal(b.count(), 0);
});

test("secondary mouse buttons and secondary touch contacts do not dismiss", () => {
  const b = backdrop();
  for (const options of [{ button: 2 }, { isPrimary: false }]) {
    b.send("pointerdown", b.overlay, options); b.send("pointerup"); b.send("click");
  }
  assert.equal(b.count(), 0);
});
