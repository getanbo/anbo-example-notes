import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { PutEventsCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { StartExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { Pool } from "pg";

const endpoint = required("ANBO_MINISTACK_ENDPOINT");
const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "000000000000",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "anbo-local"
};
const clientOptions = { endpoint, region, credentials };
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient(clientOptions));
const s3 = new S3Client({ ...clientOptions, forcePathStyle: true });
const sqs = new SQSClient(clientOptions);
const sns = new SNSClient(clientOptions);
const events = new EventBridgeClient(clientOptions);
const sfn = new SFNClient(clientOptions);
const postgres = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : undefined;

const resources = {
  table: required("NOTES_TABLE"),
  bucket: required("ATTACHMENTS_BUCKET"),
  queueName: required("EVENTS_QUEUE_NAME"),
  topicArn: required("NOTIFICATIONS_TOPIC_ARN"),
  eventBus: required("EVENT_BUS_NAME"),
  stateMachineArn: required("STATE_MACHINE_ARN")
};
const discoveredQueueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: resources.queueName }))).QueueUrl;
if (!discoveredQueueUrl) throw new Error(`SQS did not return a URL for ${resources.queueName}`);
const queueUrl = new URL(new URL(discoveredQueueUrl).pathname, `${endpoint}/`).toString();

if (postgres) {
  await postgres.query(`
    create table if not exists anbo_demo_notes (
      id text primary key,
      title text not null,
      body text not null,
      created_at timestamptz not null
    )
  `);
}

const server = createServer(async (request, response) => {
  const correlationId = request.headers["x-correlation-id"]?.toString() ?? randomUUID();
  try {
    const url = new URL(request.url ?? "/", "http://notes.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true, service: "notes", postgres: Boolean(postgres) });
    }
    if (request.method === "POST" && url.pathname === "/notes") {
      const input = await readJson(request);
      const note = {
        id: stringField(input, "id") ?? randomUUID(),
        title: requiredField(input, "title"),
        body: stringField(input, "body") ?? "",
        created_at: new Date().toISOString()
      };
      await dynamodb.send(new PutCommand({ TableName: resources.table, Item: note }));
      await s3.send(new PutObjectCommand({
        Bucket: resources.bucket,
        Key: `notes/${note.id}.json`,
        Body: JSON.stringify(note),
        ContentType: "application/json"
      }));
      if (postgres) {
        await postgres.query(
          "insert into anbo_demo_notes(id,title,body,created_at) values($1,$2,$3,$4) on conflict(id) do update set title=excluded.title, body=excluded.body",
          [note.id, note.title, note.body, note.created_at]
        );
      }
      const event = { type: "note.created", note_id: note.id, correlation_id: correlationId };
      const [queue, notification, eventBridge, workflow] = await Promise.all([
        sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) })),
        sns.send(new PublishCommand({ TopicArn: resources.topicArn, Message: JSON.stringify(event) })),
        events.send(new PutEventsCommand({ Entries: [{
          EventBusName: resources.eventBus,
          Source: "anbo.notes",
          DetailType: "NoteCreated",
          Detail: JSON.stringify(event)
        }] })),
        sfn.send(new StartExecutionCommand({
          stateMachineArn: resources.stateMachineArn,
          name: `note-${note.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60)}-${Date.now()}`,
          input: JSON.stringify({ operation: "workflow", note })
        }))
      ]);
      log("note.created", correlationId, { id: note.id, queue_message_id: queue.MessageId });
      return json(response, 201, {
        ...note,
        execution_arn: workflow.executionArn,
        notification_id: notification.MessageId,
        eventbridge_failures: eventBridge.FailedEntryCount ?? 0
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/notes/")) {
      const id = decodeURIComponent(url.pathname.slice("/notes/".length));
      const result = await dynamodb.send(new GetCommand({ TableName: resources.table, Key: { id } }));
      if (!result.Item) return json(response, 404, { error: "note_not_found", id });
      return json(response, 200, result.Item);
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    log("request.failed", correlationId, { error: error instanceof Error ? error.message : String(error) });
    return json(response, 500, { error: "request_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(8080, "0.0.0.0", () => log("service.ready", "startup", { port: 8080 }));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; start this service through anbo`);
  return value;
}

function stringField(value, name) {
  return value && typeof value === "object" && typeof value[name] === "string" ? value[name] : undefined;
}

function requiredField(value, name) {
  const result = stringField(value, name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

function log(kind, correlationId, fields) {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, kind, correlation_id: correlationId, ...fields })}\n`);
}
