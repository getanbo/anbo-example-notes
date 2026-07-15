import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DescribeLogGroupsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { ListEventSourceMappingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetBucketTaggingCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { ListTagsForResourceCommand, SNSClient } from "@aws-sdk/client-sns";
import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { durationMs, timedAssertion } from "./test-timing.mjs";

const runId = required("ANBO_RUN_ID");
const testRunId = required("ANBO_TEST_RUN_ID");
const endpoint = required("ANBO_MINISTACK_ENDPOINT");
const apiId = required("API_ID");
const tableName = required("NOTES_TABLE");
const bucketName = required("ATTACHMENTS_BUCKET");
const queueName = required("EVENTS_QUEUE_NAME");
const topicArn = required("NOTIFICATIONS_TOPIC_ARN");
const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "000000000000",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "anbo-local"
};
const options = { endpoint, region, credentials };
const testStartedAt = performance.now();
emit("test.started", { name: "notes-flow" });
try {
const sqs = new SQSClient(options);
const discoveredQueueUrl = await timedAssertion("sqs.queue_discovery", async () => {
  const value = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
  assert.ok(value, `SQS did not return a URL for ${queueName}`);
  return value;
}, { emit, fields: () => ({ queue_name: queueName }) });
const queueUrl = new URL(new URL(discoveredQueueUrl).pathname, `${endpoint}/`).toString();

const id = `note-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
const created = await timedAssertion("note.create", async () => {
  const response = await fetch("http://127.0.0.1:8080/notes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": testRunId },
    body: JSON.stringify({ id, title: "Anbo CLI smoke", body: "one agent-visible flow" })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.id, id);
  assert.equal(body.eventbridge_failures, 0);
  assert.ok(body.execution_arn);
  return body;
}, { emit, fields: () => ({ id }) });

await timedAssertion("note.read", async () => {
  const response = await fetch(`http://127.0.0.1:8080/notes/${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "Anbo CLI smoke");
}, { emit });

const s3 = new S3Client({ ...options, forcePathStyle: true });
await timedAssertion("s3.attachment", () => s3.send(new HeadObjectCommand({
  Bucket: bucketName,
  Key: `notes/${id}.json`
})), { emit });

await timedAssertion("sns.tags", async () => {
  const tags = Object.fromEntries(
    (await new SNSClient(options).send(new ListTagsForResourceCommand({ ResourceArn: topicArn }))).Tags
    ?.map(({ Key, Value }) => [Key, Value]) ?? []
  );
  assert.deepEqual(tags, { ManagedBy: "anbo", Project: "anbo-notes" });
  return tags;
}, { emit, fields: (tags) => ({ tags }) });

await timedAssertion("s3.tags", async () => {
  const tags = Object.fromEntries(
    (await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }))).TagSet
    ?.map(({ Key, Value }) => [Key, Value]) ?? []
  );
  assert.deepEqual(tags, { ManagedBy: "anbo", Project: "anbo-notes" });
  return tags;
}, { emit, fields: (tags) => ({ tags }) });

const table = await timedAssertion("dynamodb.stream", async () => {
  const value = await new DynamoDBClient(options).send(new DescribeTableCommand({ TableName: tableName }));
  assert.equal(value.Table?.StreamSpecification?.StreamEnabled, true);
  assert.ok(value.Table?.LatestStreamArn);
  return value;
}, { emit, fields: (value) => ({ stream_arn: value.Table.LatestStreamArn }) });

await timedAssertion("apigateway.lambda", async () => {
  const response = await fetch(`${endpoint}/_aws/execute-api/${apiId}/$default/health`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.service, "notes-lambda");
}, { emit });

await timedAssertion("events.queue", async () => {
  const message = await waitForMessage(sqs, queueUrl, id);
  assert.ok(message.ReceiptHandle);
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  return message;
}, { emit, fields: (message) => ({ message_id: message.MessageId }) });

await timedAssertion("secrets.read", async () => {
  const secret = await new SecretsManagerClient(options).send(new GetSecretValueCommand({ SecretId: required("SECRET_ARN") }));
  assert.match(secret.SecretString ?? "", /notes-demo/);
}, { emit });

await timedAssertion("ssm.read", async () => {
  const parameter = await new SSMClient(options).send(new GetParameterCommand({ Name: required("PARAMETER_NAME") }));
  assert.equal(parameter.Parameter?.Value, "enabled");
}, { emit });

await timedAssertion("stepfunctions.execution", async () => {
  const execution = await new SFNClient(options).send(new DescribeExecutionCommand({ executionArn: created.execution_arn }));
  assert.ok(["RUNNING", "SUCCEEDED"].includes(execution.status ?? ""));
  return execution;
}, { emit, fields: (execution) => ({ status: execution.status }) });

await timedAssertion("lambda.dynamodb_stream_mapping", async () => {
  const mappings = await new LambdaClient(options).send(new ListEventSourceMappingsCommand({
    FunctionName: required("LAMBDA_NAME")
  }));
  assert.ok((mappings.EventSourceMappings ?? []).some((mapping) => mapping.EventSourceArn === table.Table?.LatestStreamArn));
}, { emit });

await timedAssertion("iam.role", async () => {
  const roleName = required("LAMBDA_ROLE_NAME");
  const role = await new IAMClient(options).send(new GetRoleCommand({ RoleName: roleName }));
  assert.equal(role.Role?.RoleName, roleName);
}, { emit });

await timedAssertion("cloudwatch.logs", async () => {
  const logs = await new CloudWatchLogsClient(options).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/anbo/notes" }));
  assert.ok((logs.logGroups ?? []).some((group) => group.logGroupName === "/anbo/notes"));
}, { emit });
emit("test.finished", { name: "notes-flow", status: "passed", duration_ms: durationMs(testStartedAt) });
} catch (error) {
  emit("test.finished", {
    name: "notes-flow",
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
    duration_ms: durationMs(testStartedAt)
  });
  throw error;
}

async function waitForMessage(client, url, expected) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const match = response.Messages?.find((candidate) => candidate.Body?.includes(expected));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no queue message contained ${expected}`);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run this test through anbo`);
  return value;
}

function emit(kind, fields) {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, kind, run_id: runId, correlation_id: testRunId, ...fields })}\n`);
}
