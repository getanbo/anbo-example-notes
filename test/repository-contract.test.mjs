import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Terraform lock includes the verified Linux ARM64 AWS provider checksum", async () => {
  const lock = await readFile(new URL("infra/.terraform.lock.hcl", root), "utf8");

  assert.match(lock, /provider "registry\.terraform\.io\/hashicorp\/aws"/u);
  assert.match(lock, /"h1:taVoUOoF8lurC83\+IGQpSDd02x1HATc3YFfj5\+Atahs="/u);
});

test("README distinguishes incremental deploys from explicit reconciliation", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");

  assert.match(readme, /ordinary\s+`anbo deploy` is the incremental development path/u);
  assert.match(readme, /anbo deploy --reconcile --output=jsonl/u);
  assert.match(readme, /Older CLI releases that do not list the flag always reconcile Terraform/u);
});
