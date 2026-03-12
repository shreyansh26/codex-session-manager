import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const desktopRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const targetRoot = resolve(workspaceRoot, "target");
const normalizePath = (value) => value.replaceAll("\\", "/");
const expectedTargetPrefix = `${normalizePath(targetRoot)}/`;
const buildRoots = [
  resolve(targetRoot, "debug", "build"),
  resolve(targetRoot, "release", "build")
];

async function listRootOutputFiles(buildRoot) {
  try {
    const entries = await readdir(buildRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(buildRoot, entry.name, "root-output"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function findStaleRootOutput() {
  for (const buildRoot of buildRoots) {
    const rootOutputFiles = await listRootOutputFiles(buildRoot);
    for (const rootOutputFile of rootOutputFiles) {
      try {
        const value = (await readFile(rootOutputFile, "utf8")).trim();
        if (value.length === 0) {
          continue;
        }
        const normalizedValue = normalizePath(value);
        if (!normalizedValue.startsWith(expectedTargetPrefix)) {
          return {
            rootOutputFile,
            cachedPath: value
          };
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
  }

  return null;
}

async function main() {
  const staleEntry = await findStaleRootOutput();
  if (!staleEntry) {
    return;
  }

  console.warn("[tauri:preflight] Detected stale Cargo/Tauri target metadata from a different workspace path.");
  console.warn(`[tauri:preflight] Cached path: ${staleEntry.cachedPath}`);
  console.warn(`[tauri:preflight] Current target root: ${targetRoot}`);
  console.warn(`[tauri:preflight] Removing ${targetRoot} so Tauri can rebuild with the current path.`);
  await rm(targetRoot, { recursive: true, force: true });
}

await main();
