import assert from "node:assert/strict";
import { DescribeLogGroupsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { ListEventSourceMappingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const runId = required("ANBO_RUN_ID");
const testRunId = required("ANBO_TEST_RUN_ID");
const endpoint = required("ANBO_MINISTACK_ENDPOINT");
const apiId = required("API_ID");
const tableName = required("NOTES_TABLE");
const bucketName = required("ATTACHMENTS_BUCKET");
const queueName = required("EVENTS_QUEUE_NAME");
const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "000000000000",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "anbo-local"
};
const options = { endpoint, region, credentials };
emit("test.started", { name: "notes-flow" });
try {
const sqs = new SQSClient(options);
const discoveredQueueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
assert.ok(discoveredQueueUrl, `SQS did not return a URL for ${queueName}`);
const queueUrl = new URL(new URL(discoveredQueueUrl).pathname, `${endpoint}/`).toString();

const id = `note-${runId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
const createdResponse = await fetch("http://127.0.0.1:8080/notes", {
  method: "POST",
  headers: { "content-type": "application/json", "x-correlation-id": testRunId },
  body: JSON.stringify({ id, title: "Anbo CLI smoke", body: "one agent-visible flow" })
});
const created = await createdResponse.json();
assert.equal(createdResponse.status, 201, JSON.stringify(created));
assert.equal(created.id, id);
assert.equal(created.eventbridge_failures, 0);
assert.ok(created.execution_arn);
passed("note.create", { id });

const loadedResponse = await fetch(`http://127.0.0.1:8080/notes/${encodeURIComponent(id)}`);
assert.equal(loadedResponse.status, 200);
assert.equal((await loadedResponse.json()).title, "Anbo CLI smoke");
passed("note.read");

await new S3Client({ ...options, forcePathStyle: true }).send(new HeadObjectCommand({
  Bucket: bucketName,
  Key: `notes/${id}.json`
}));
passed("s3.attachment");

const table = await new DynamoDBClient(options).send(new DescribeTableCommand({ TableName: tableName }));
assert.equal(table.Table?.StreamSpecification?.StreamEnabled, true);
assert.ok(table.Table?.LatestStreamArn);
passed("dynamodb.stream", { stream_arn: table.Table.LatestStreamArn });

const gatewayResponse = await fetch(`${endpoint}/_aws/execute-api/${apiId}/$default/health`);
const gateway = await gatewayResponse.json();
assert.equal(gatewayResponse.status, 200, JSON.stringify(gateway));
assert.equal(gateway.service, "notes-lambda");
passed("apigateway.lambda");

const message = await waitForMessage(sqs, queueUrl, id);
assert.ok(message.ReceiptHandle);
await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
passed("events.queue", { message_id: message.MessageId });

const secret = await new SecretsManagerClient(options).send(new GetSecretValueCommand({ SecretId: required("SECRET_ARN") }));
assert.match(secret.SecretString ?? "", /notes-demo/);
passed("secrets.read");

const parameter = await new SSMClient(options).send(new GetParameterCommand({ Name: required("PARAMETER_NAME") }));
assert.equal(parameter.Parameter?.Value, "enabled");
passed("ssm.read");

const execution = await new SFNClient(options).send(new DescribeExecutionCommand({ executionArn: created.execution_arn }));
assert.ok(["RUNNING", "SUCCEEDED"].includes(execution.status ?? ""));
passed("stepfunctions.execution", { status: execution.status });

const mappings = await new LambdaClient(options).send(new ListEventSourceMappingsCommand({
  FunctionName: required("LAMBDA_NAME")
}));
assert.ok((mappings.EventSourceMappings ?? []).some((mapping) => mapping.EventSourceArn === table.Table?.LatestStreamArn));
passed("lambda.dynamodb_stream_mapping");

const role = await new IAMClient(options).send(new GetRoleCommand({ RoleName: required("LAMBDA_ROLE_NAME") }));
assert.equal(role.Role?.RoleName, required("LAMBDA_ROLE_NAME"));
passed("iam.role");

const logs = await new CloudWatchLogsClient(options).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: "/anbo/notes" }));
assert.ok((logs.logGroups ?? []).some((group) => group.logGroupName === "/anbo/notes"));
passed("cloudwatch.logs");
emit("test.finished", { name: "notes-flow", status: "passed" });
} catch (error) {
  emit("test.finished", {
    name: "notes-flow",
    status: "failed",
    message: error instanceof Error ? error.message : String(error)
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

function passed(name, fields = {}) {
  emit("test.assertion", { name, status: "passed", passed: true, ...fields });
}

function emit(kind, fields) {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, kind, run_id: runId, correlation_id: testRunId, ...fields })}\n`);
}
