import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const indexerDir = fileURLToPath(new URL("../", import.meta.url));
const loaderUrl = pathToFileURL(resolve(indexerDir, "node_modules/envio/src/HandlerLoader.res.mjs")).href;

// Exercise the pinned SDK's runtime loader, which codegen does not run.
function loadHandler(cwd) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    const loader = await import(${JSON.stringify(loaderUrl)});
    loader.registerTsHooks();
    await loader.importHandler("./src/EventHandlers.ts");
    console.log("handler-loaded");
  `], { cwd, encoding: "utf8", timeout: 10000 });
}

test("indexer: production handler loads through the Envio runtime SDK", () => {
  const result = loadHandler(indexerDir);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /handler-loaded/);
});

test("indexer: missing ESM declaration reproduces the cloud startup rejection", () => {
  const fixture = mkdtempSync(join(tmpdir(), "archava-indexer-runtime-"));
  try {
    mkdirSync(join(fixture, "src"));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "missing-module-type", private: true }));
    copyFileSync(join(indexerDir, "src/EventHandlers.ts"), join(fixture, "src/EventHandlers.ts"));
    symlinkSync(join(indexerDir, "node_modules"), join(fixture, "node_modules"), "dir");
    const result = loadHandler(fixture);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Add "type": "module"/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
