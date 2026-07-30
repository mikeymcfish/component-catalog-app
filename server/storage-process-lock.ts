import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
  storagePath: string;
}

export interface StorageProcessLock {
  lockPath: string;
  release: () => void;
}

function canonicalizeStoragePath(filePath: string) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });
  const canonicalDirectory = fs.realpathSync.native(directory);
  return path.join(canonicalDirectory, path.basename(resolved));
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (
      !Number.isInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.token !== "string"
      || !value.token
      || typeof value.acquiredAt !== "string"
      || typeof value.storagePath !== "string"
    ) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

function removeStaleLock(lockPath: string) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function acquireJsonStorageProcessLock(filePath: string): StorageProcessLock {
  const storagePath = canonicalizeStoragePath(filePath);
  const lockPath = `${storagePath}.lock`;
  const token = randomUUID();
  const owner: LockOwner = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    storagePath,
  };

  try {
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const existingOwner = readOwner(lockPath);
    if (existingOwner && isProcessAlive(existingOwner.pid)) {
      throw new Error(
        `Component Catalog storage is already open by process ${existingOwner.pid}: ${storagePath}. Close the other Component Catalog server before starting another one.`,
      );
    }

    const ownerDescription = existingOwner
      ? `left by stopped process ${existingOwner.pid}`
      : "with incomplete owner information";
    throw new Error(
      `A stale Component Catalog storage lock ${ownerDescription} exists at ${lockPath}. Confirm that no Component Catalog server is running, delete that .lock file, and start again.`,
    );
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    const currentOwner = readOwner(lockPath);
    if (currentOwner?.token === token) removeStaleLock(lockPath);
  };
  process.once("exit", release);
  return { lockPath, release };
}
