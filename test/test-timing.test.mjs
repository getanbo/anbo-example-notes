import assert from "node:assert/strict";
import test from "node:test";

import { timedAssertion } from "../scripts/test-timing.mjs";

test("timedAssertion emits a monotonic duration for a passing section", async () => {
  const events = [];
  const times = [100, 112.6];
  const result = await timedAssertion("note.read", async () => ({ title: "Anbo CLI smoke" }), {
    emit: (kind, fields) => events.push({ kind, ...fields }),
    fields: (value) => ({ title: value.title }),
    now: () => times.shift()
  });

  assert.deepEqual(result, { title: "Anbo CLI smoke" });
  assert.deepEqual(events, [{
    kind: "test.assertion",
    title: "Anbo CLI smoke",
    name: "note.read",
    status: "passed",
    passed: true,
    duration_ms: 13
  }]);
});

test("timedAssertion emits failed timing before rethrowing", async () => {
  const events = [];
  const times = [40, 47.4];
  const failure = new Error("response status was 500");

  await assert.rejects(
    timedAssertion("note.create", async () => { throw failure; }, {
      emit: (kind, fields) => events.push({ kind, ...fields }),
      now: () => times.shift()
    }),
    (error) => error === failure
  );
  assert.deepEqual(events, [{
    kind: "test.assertion",
    name: "note.create",
    status: "failed",
    passed: false,
    duration_ms: 7,
    message: "response status was 500"
  }]);
});
