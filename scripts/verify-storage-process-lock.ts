import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireJsonStorageProcessLock } from "../server/storage-process-lock";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "component-catalog-lock-test-"));
const storagePath = path.join(tempDirectory, "storage.json");
const workerPath = fileURLToPath(new URL("./verify-storage-process-lock-worker.ts", import.meta.url));

function runWorker() {
  return spawnSync(process.execPath, ["--import", "tsx", workerPath, storagePath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

try {
  const firstLock = acquireJsonStorageProcessLock(storagePath);
  const blockedWorker = runWorker();
  assert.equal(blockedWorker.status, 2, `A second process should be blocked: ${blockedWorker.stderr}`);
  assert.match(blockedWorker.stderr, /storage is already open by process/);
  const lockPath = firstLock.lockPath;
  firstLock.release();

  const allowedWorker = runWorker();
  assert.equal(allowedWorker.status, 0, `The lock should be reusable after release: ${allowedWorker.stderr}`);
  assert.equal(fs.existsSync(lockPath), false, "A normal process exit should remove its storage lock");

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-test-token",
    acquiredAt: "2000-01-01T00:00:00.000Z",
    storagePath,
  }));
  assert.throws(
    () => acquireJsonStorageProcessLock(storagePath),
    /stale Component Catalog storage lock/,
    "Stale locks must fail closed instead of racing another recovery process",
  );
  fs.unlinkSync(lockPath);
  const recoveredLock = acquireJsonStorageProcessLock(storagePath);
  recoveredLock.release();
  assert.equal(fs.existsSync(lockPath), false, "Releasing the recovered lock should remove its lock file");
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("Storage process lock verification passed.");
