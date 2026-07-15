# Anbo Notes

Anbo Notes is the agent-first reference project for the canonical `anbo` CLI.
One CLI command discovers ordinary AWS Terraform, starts the digest-pinned Anbo
MiniStack distribution, builds the application and Lambda once, applies
Terraform, starts the API, and runs a behavioral smoke test:

```bash
./node_modules/.bin/anbo deploy --target ministack --output=jsonl
```

The JSONL stream is the product interface for an agent. It contains ordered
phases, stable diagnostic codes, service logs, test assertions, a correlation
ID, remediation, and exactly one terminal `run.finished` event.

## What This Project Certifies

The note creation flow exercises all of these resources through one deployed
application:

- DynamoDB, DynamoDB Streams, and a Lambda event-source mapping;
- S3 object storage;
- direct SQS delivery, SNS-to-SQS fanout, and EventBridge-to-SQS delivery;
- EventBridge events and rules;
- Lambda behind API Gateway v2;
- a Step Functions workflow that invokes Lambda;
- IAM roles and policies;
- Secrets Manager and SSM Parameter Store;
- CloudWatch Logs;
- an optional PostgreSQL clone supplied as a cloud URL;
- an optional DynamoDB clone supplied as a cloud endpoint and temporary
  credentials.

The Terraform remains provider-portable. It contains no MiniStack endpoint,
local credential, provider-skip flag, backend override, or test-only resource.
The MiniStack plugin owns all local provider configuration.

## Prerequisites

- Node.js 22 or newer
- Docker Engine or Docker Desktop with Buildx
- the canonical `anbo` package and `@getanbo/plugin-ministack`

Terraform is not required on the host. Anbo runs its pinned Terraform worker.

Install released packages exactly in this project:

```bash
npm install
npm install --save-dev --save-exact anbo@0.2.0 @getanbo/plugin-ministack@0.1.0
```

Until those versions are published, the repository acceptance workflow packs
the exact CLI, SDK, and plugin candidate refs, installs the tarballs in an empty
prefix, and uses only that prefix's `node_modules/.bin/anbo`.

## Agent Workflow

Run commands from the repository root. Do not invoke Terraform, Docker, the
application smoke script, or plugin entrypoints directly.

```bash
./node_modules/.bin/anbo plugin list --output=jsonl
./node_modules/.bin/anbo configure --target ministack --output=jsonl
./node_modules/.bin/anbo doctor --output=jsonl
./node_modules/.bin/anbo deploy --output=jsonl
./node_modules/.bin/anbo status --output=jsonl
./node_modules/.bin/anbo test --output=jsonl
./node_modules/.bin/anbo logs --service api --follow --output=jsonl
./node_modules/.bin/anbo debug --output=jsonl
./node_modules/.bin/anbo down --purge --output=jsonl
./node_modules/.bin/anbo cache prune --output=jsonl
```

`deploy` runs the default `notes-flow` smoke test. A second deploy must report
zero Terraform changes and cache hits for both the API image and Lambda
artifact. Stop `logs --follow` with `SIGINT`; the CLI emits cancellation and
terminal events before exiting with code 130.

The compatibility alias is also supported:

```bash
./node_modules/.bin/anbo sandbox up --output=jsonl
```

## Data Clone URLs

The default manifest uses MiniStack DynamoDB and no PostgreSQL database, so it
runs without cloud credentials. To bind clones from an existing cloud cloning
service, merge the example `data` section into the manifest root and its
`service_bindings` section into `services.api`.
[`.anbo/clones.external.example.json`](.anbo/clones.external.example.json)
contains the complete binding fragment. Then provide secrets only through the
environment:

```bash
export ANBO_DEMO_POSTGRES_URL='postgresql://user:password@clone.example.com/notes?sslmode=require'
export ANBO_DEMO_DYNAMODB_ENDPOINT='https://dynamodb-clone.example.com'
export ANBO_DEMO_DYNAMODB_ACCESS_KEY_ID='temporary-access-key'
export ANBO_DEMO_DYNAMODB_SECRET_ACCESS_KEY='temporary-secret-key'
export ANBO_DEMO_DYNAMODB_SESSION_TOKEN='temporary-session-token'
./node_modules/.bin/anbo deploy --output=jsonl
```

The manifest stores only `env://` references. Clone URLs and credentials are
resolved for the current run, redacted from events, and never written into
Terraform state or committed files. A remote HTTP clone endpoint must use
HTTPS, and credentials must not be embedded in its URL.

When `dynamodb_plane` is `clone`, the source clone must contain the table named
by the Terraform output. PostgreSQL is additive: the API creates its demo table
inside the supplied clone and continues to use MiniStack for AWS services.

## Repository Map

| Path | Purpose |
| --- | --- |
| `.anbo/project.json` | Explicit MiniStack plugin selection |
| `.anbo/sandbox.json` | Builds, services, tests, runtime digest, and Terraform roots |
| `infra/` | Portable AWS Terraform |
| `lambda/` | API Gateway, workflow, and stream Lambda handler |
| `src/server.mjs` | Notes API and multi-service write path |
| `scripts/smoke.mjs` | In-container JSONL behavioral test, invoked only by Anbo |
| `scripts/acceptance.mjs` | Packed-installed-CLI acceptance orchestrator |

## Failure Handling

Start with the terminal event's diagnostic code and remediation. Preserve the
run ID while inspecting state:

```bash
./node_modules/.bin/anbo debug --output=jsonl
./node_modules/.bin/anbo logs --service api --output=jsonl
./node_modules/.bin/anbo status --output=jsonl
```

Never paste clone URLs, credentials, `.anbo/state`, Terraform state, or
unredacted application data into an issue. See [SECURITY.md](SECURITY.md) for
private reporting.

## Acceptance Rule

Unit and static checks may use their native tools. Every deploy, integration,
smoke, recovery, cleanup, and release-qualification behavior must enter through
a packed and installed `anbo` binary. CI intentionally has no direct Terraform,
Docker, Lambda build, or smoke-test invocation.
