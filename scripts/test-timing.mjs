import { performance } from "node:perf_hooks";

export function durationMs(startedAt, finishedAt = performance.now()) {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

export async function timedAssertion(name, operation, { emit, fields = () => ({}), now = () => performance.now() }) {
  const startedAt = now();
  try {
    const result = await operation();
    emit("test.assertion", {
      ...fields(result),
      name,
      status: "passed",
      passed: true,
      duration_ms: durationMs(startedAt, now())
    });
    return result;
  } catch (error) {
    emit("test.assertion", {
      name,
      status: "failed",
      passed: false,
      duration_ms: durationMs(startedAt, now()),
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
