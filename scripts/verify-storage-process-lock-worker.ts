import { acquireJsonStorageProcessLock } from "../server/storage-process-lock";

const storagePath = process.argv[2];
if (!storagePath) throw new Error("Expected a storage path argument");

try {
  acquireJsonStorageProcessLock(storagePath);
  console.log("Storage lock acquired.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
