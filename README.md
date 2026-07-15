# Anbo Notes

Anbo Notes is the agent-first reference project for the canonical `anbo` CLI.
One CLI command discovers ordinary AWS Terraform, starts the digest-pinned Anbo
MiniStack distribution, builds the application and Lambda once, applies
Terraform, starts the API, and runs a behavioral smoke test:

```bash
anbo deploy --target ministack --output=jsonl
```

The JSONL stream is the product interface for an agent. It contains ordered
phases, stable diagnostic codes, service logs, test assertions, a correlation
ID, remediation, and exactly one terminal `run.finished` event. Each smoke
section's promoted `test.assertion` includes its monotonic `duration_ms`;
`test.finished` includes the total smoke-test duration.

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
- the canonical `anbo` package and official `@getanbo` plugins

Terraform is not required on the host. Anbo runs its pinned Terraform worker.
The CLI, plugin SDK, and both official plugins are maintained together in the
[`getanbo/anbo-cli`](https://github.com/getanbo/anbo-cli) monorepo.

Install the application dependencies, then install the released CLI and its
official plugins globally so `anbo` is available on `PATH`:

```bash
npm install
npm install --global anbo@0.2.0 @getanbo/plugin-ministack@0.1.0 @getanbo/plugin-cloud@0.1.0
```

Until those versions are published, the repository acceptance workflow packs
the CLI, SDK, MiniStack plugin, and cloud plugin from one exact monorepo ref,
installs the tarballs in an empty prefix, and uses only that prefix's
`node_modules/.bin/anbo`.

## Agent Workflow

Run commands from the repository root. Do not invoke Terraform, Docker, the
application smoke script, or plugin entrypoints directly.

```bash
anbo plugin list --output=jsonl
anbo configure --target ministack --output=jsonl
anbo doctor --output=jsonl
anbo deploy --output=jsonl
anbo status --output=jsonl
anbo test --output=jsonl
anbo logs --service api --follow --output=jsonl
anbo debug --output=jsonl
anbo down --purge --output=jsonl
anbo cache prune --output=jsonl
```

`deploy` runs the default `notes-flow` smoke test. A second deploy must report
zero Terraform changes and cache hits for both the API image and Lambda
artifact. Stop `logs --follow` with `SIGINT`; the CLI emits cancellation and
terminal events before exiting with code 130.

### Incremental Deploys

With an Anbo CLI release that lists the `--reconcile` flag, ordinary
`anbo deploy` is the incremental development path. It reuses unchanged build
artifacts and can reuse recorded Terraform state and outputs when the
Terraform inputs have not changed.

Force Terraform to refresh and reconcile the declared infrastructure against
MiniStack when you suspect drift or need to verify out-of-band changes:

```bash
anbo deploy --reconcile --output=jsonl
```

`--reconcile` is an explicit full infrastructure check, not the normal edit
loop. Older CLI releases that do not list the flag always reconcile Terraform;
do not pass `--reconcile` to those versions.

The compatibility alias is also supported:

```bash
anbo sandbox up --output=jsonl
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
anbo deploy --output=jsonl
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
anbo debug --output=jsonl
anbo logs --service api --output=jsonl
anbo status --output=jsonl
```

Never paste clone URLs, credentials, `.anbo/state`, Terraform state, or
unredacted application data into an issue. See [SECURITY.md](SECURITY.md) for
private reporting.

## Acceptance Rule

Unit and static checks may use their native tools. Every deploy, integration,
smoke, recovery, cleanup, and release-qualification behavior must enter through
a packed and installed `anbo` binary. CI intentionally has no direct Terraform,
Docker, Lambda build, or smoke-test invocation.
