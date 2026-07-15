import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "lambda/handler.py");
const output = resolve(root, "infra/dist/notes-lambda.zip");

await mkdir(dirname(output), { recursive: true });
await new Promise((resolveArchive, reject) => {
  const destination = createWriteStream(output, { mode: 0o600 });
  const archive = archiver("zip", { zlib: { level: 9 } });
  destination.once("close", resolveArchive);
  destination.once("error", reject);
  archive.once("error", reject);
  archive.pipe(destination);
  archive.file(source, { name: "handler.py" });
  void archive.finalize();
});

process.stdout.write(`${output}\n`);
