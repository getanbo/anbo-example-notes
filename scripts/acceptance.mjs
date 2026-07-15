import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const binary = required("ANBO_BIN");
const projectRoot = resolve(process.env.ANBO_PROJECT_ROOT ?? process.cwd());
let cleanupNeeded = true;

try {
  const plugins = await cli(["plugin", "list"]);
  const listed = event(plugins, "plugin.list");
  assert.ok(listed.data?.plugins?.some((plugin) => plugin.id === "ministack" && plugin.installed === true));

  await cli(["configure", "--target", "ministack"]);
  await cli(["doctor"]);

  const cold = await cli(["deploy"]);
  const coldResult = event(cold, "command.result").data;
  assert.equal(coldResult.status, "succeeded");
  assert.equal(coldResult.terraform_changes > 0, true, "cold Terraform apply must create resources");
  assert.equal(coldResult.builds.api.cache_hit, false, "cold API image must be built");
  assert.equal(coldResult.builds.lambda.cache_hit, false, "cold Lambda artifact must be built");
  assert.equal(coldResult.tests["notes-flow"].passed, true);

  const status = await cli(["status"]);
  assert.equal(event(status, "command.result").data.sandbox.status, "ready");

  const test = await cli(["test"]);
  assert.equal(event(test, "command.result").data.tests["notes-flow"].passed, true);

  const logs = await cli(["logs", "--service", "api"]);
  assert.ok(logs.some((entry) => entry.type === "process.output" && entry.data?.service === "api"));
  await assertFollowLogs();
  await cli(["debug"]);

  const warm = await cli(["deploy", "--no-test"]);
  const warmResult = event(warm, "command.result").data;
  assert.equal(warmResult.terraform_changes, 0, "warm Terraform apply must be idempotent");
  assert.equal(warmResult.builds.api.cache_hit, true, "warm deploy must reuse the API image");
  assert.equal(warmResult.builds.lambda.cache_hit, true, "warm deploy must reuse the Lambda artifact");
  assert.deepEqual(warmResult.tests, {}, "--no-test must skip configured smoke suites");
  assert.equal(warmResult.builds.api.fingerprint, coldResult.builds.api.fingerprint);
  assert.equal(warmResult.builds.lambda.fingerprint, coldResult.builds.lambda.fingerprint);

  await cli(["down", "--purge"]);
  await cli(["cache", "prune"]);
  cleanupNeeded = false;
  process.stdout.write("Installed Anbo CLI notes acceptance passed.\n");
} finally {
  if (cleanupNeeded) {
    await cli(["down", "--purge"], { allowFailure: true });
    await cli(["cache", "prune"], { allowFailure: true });
  }
}

async function cli(args, options = {}) {
  const result = await run([...args, "--root", projectRoot, "--output=jsonl"]);
  if (!options.allowFailure) assert.equal(result.code, 0, result.stdout || result.stderr);
  if (result.stdout.trim()) {
    const events = parseEvents(result.stdout);
    assertEventStream(events);
    if (!options.allowFailure) assert.equal(result.stderr, "", "JSONL commands must not write to stderr");
    process.stdout.write(`anbo ${args.join(" ")}: ${events.length} events\n`);
    return events;
  }
  if (!options.allowFailure) assert.fail(`anbo ${args.join(" ")} emitted no JSONL events`);
  return [];
}

async function assertFollowLogs() {
  const args = ["logs", "--service", "api", "--follow", "--root", projectRoot, "--output=jsonl"];
  const child = spawn(binary, args, { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stopped = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!stopped && stdout.includes('"type":"process.output"')) {
      stopped = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolveCode, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("anbo logs --follow did not emit a structured log within 30 seconds"));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolveCode(exitCode);
    });
  });
  assert.equal(stopped, true, stdout || stderr);
  assert.equal(code, 130, stdout || stderr);
  assert.equal(stderr, "", "JSONL log following must not write to stderr");
  const events = parseEvents(stdout);
  assertEventStream(events);
  assert.ok(events.some((entry) => entry.type === "process.output" && entry.data?.service === "api"));
  process.stdout.write(`anbo logs --follow: ${events.length} events, cancelled cleanly\n`);
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function parseEvents(output) {
  return output.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function assertEventStream(events) {
  assert.ok(events.length >= 2, "expected run.started and run.finished");
  const runId = events[0].runId;
  events.forEach((entry, index) => {
    assert.equal(entry.apiVersion, "anbo.dev/event/v1");
    assert.equal(entry.runId, runId);
    assert.equal(entry.sequence, index + 1);
  });
  assert.equal(events[0].type, "run.started");
  assert.equal(events.at(-1).type, "run.finished");
  assert.equal(events.filter((entry) => entry.type === "run.finished").length, 1);
}

function event(events, type) {
  const found = events.find((entry) => entry.type === type);
  assert.ok(found, `missing ${type} event`);
  return found;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; acceptance must use a packed, installed Anbo CLI`);
  return value;
}
