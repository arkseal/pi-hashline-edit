import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const RUST_BINARY_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../crates/hashline/target/release/hashline"
);

export interface HashlineApplyResult {
  success: boolean;
  updatedFiles: string[];
  output: string;
  error?: string;
}

/**
 * Compute 4-hex snapshot tag for file content (CRC32 lower 16 bits).
 */
export function computeSnapshotTag(content: string): string {
  let crc = 0 ^ -1;
  const bytes = Buffer.from(content, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  const checksum = (crc ^ -1) >>> 0;
  const tagNum = checksum & 0xffff;
  return tagNum.toString(16).padStart(4, "0");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function runRustHashline(patchText: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(RUST_BINARY_PATH, ["apply"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    child.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, code: 1 });
    });

    child.stdin.write(patchText);
    child.stdin.end();
  });
}

export async function applyHashlinePatch(
  patchText: string,
  baseDirectory: string
): Promise<HashlineApplyResult> {
  if (fsSync.existsSync(RUST_BINARY_PATH)) {
    const { stdout, stderr, code } = await runRustHashline(patchText, baseDirectory);
    if (code === 0) {
      const updatedFiles: string[] = [];
      for (const line of stdout.split("\n")) {
        if (line.startsWith("Updated: ")) {
          const match = line.match(/^Updated: ([^ ]+)/);
          if (match) updatedFiles.push(match[1]);
        }
      }
      return {
        success: true,
        updatedFiles,
        output: stdout.trim(),
      };
    } else {
      const err = (stderr || stdout).trim();
      return {
        success: false,
        updatedFiles: [],
        output: err,
        error: err,
      };
    }
  }

  // Pure TypeScript fallback
  return applyHashlinePatchJs(patchText, baseDirectory);
}

interface ParsedOp {
  type: "range" | "before" | "after" | "append" | "cut" | "remove" | "move";
  start?: number;
  end?: number;
  target?: number;
  dest?: string;
  body?: string[];
}

interface ParsedFilePatch {
  filePath: string;
  expectedTag?: string;
  ops: ParsedOp[];
}

async function applyHashlinePatchJs(
  patchText: string,
  baseDirectory: string
): Promise<HashlineApplyResult> {
  const patches: ParsedFilePatch[] = [];
  const lines = patchText.split("\n").map((l) => l.trimEnd());

  let currentPatch: ParsedFilePatch | null = null;
  let currentOp: ParsedOp | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      if (currentOp && currentPatch) currentPatch.ops.push(currentOp);
      currentOp = null;
      if (currentPatch) patches.push(currentPatch);

      const inner = line.slice(1, -1).trim();
      const hashIdx = inner.lastIndexOf("#");
      let filePath = inner;
      let expectedTag: string | undefined;

      if (hashIdx !== -1) {
        filePath = inner.slice(0, hashIdx).trim();
        expectedTag = inner.slice(hashIdx + 1).trim();
      }

      currentPatch = { filePath, expectedTag, ops: [] };
      continue;
    }

    if (line.startsWith("PUT ") || line.startsWith("CUT ") || line === "REM" || line.startsWith("MV ")) {
      if (currentOp && currentPatch) currentPatch.ops.push(currentOp);
      currentOp = null;

      if (line === "REM") {
        currentOp = { type: "remove" };
      } else if (line.startsWith("MV ")) {
        currentOp = { type: "move", dest: line.slice(3).trim() };
      } else if (line.startsWith("CUT ")) {
        const spec = line.slice(4).trim();
        const [start, end] = parseRange(spec);
        currentOp = { type: "cut", start, end };
      } else if (line.startsWith("PUT ")) {
        let spec = line.slice(4).replace(/:$/, "").trim();
        if (spec.startsWith("<")) {
          currentOp = { type: "before", target: parseInt(spec.slice(1).trim(), 10), body: [] };
        } else if (spec.startsWith(">")) {
          const rest = spec.slice(1).trim();
          if (rest === "$") {
            currentOp = { type: "append", body: [] };
          } else {
            currentOp = { type: "after", target: parseInt(rest, 10), body: [] };
          }
        } else {
          const [start, end] = parseRange(spec);
          currentOp = { type: "range", start, end, body: [] };
        }
      }
      continue;
    }

    if (lines[i].startsWith("+")) {
      if (currentOp && currentOp.body) {
        currentOp.body.push(lines[i].slice(1));
      } else {
        return {
          success: false,
          updatedFiles: [],
          output: `Encountered '+' line without active PUT operation: ${lines[i]}`,
          error: "Invalid patch format",
        };
      }
    }
  }

  if (currentOp && currentPatch) currentPatch.ops.push(currentOp);
  if (currentPatch) patches.push(currentPatch);

  if (patches.length === 0) {
    return { success: false, updatedFiles: [], output: "Empty patch", error: "Empty patch" };
  }

  const updatedFiles: string[] = [];

  for (const patch of patches) {
    const resolvedPath = path.isAbsolute(patch.filePath)
      ? patch.filePath
      : path.resolve(baseDirectory, patch.filePath);

    let content = "";
    try {
      content = await fs.readFile(resolvedPath, "utf-8");
    } catch {
      content = "";
    }

    if (patch.expectedTag) {
      const actualTag = computeSnapshotTag(content);
      if (patch.expectedTag.toLowerCase() !== actualTag.toLowerCase()) {
        return {
          success: false,
          updatedFiles,
          output: `Snapshot tag mismatch on ${patch.filePath}: expected #${patch.expectedTag}, but file on disk has #${actualTag}. Please re-read file before patching.`,
          error: "Snapshot tag mismatch",
        };
      }
    }

    let fileLines = content.split("\n");
    const sortedOps = [...patch.ops].sort((a, b) => {
      const lineA = a.target ?? a.start ?? 0;
      const lineB = b.target ?? b.start ?? 0;
      return lineB - lineA;
    });

    for (const op of sortedOps) {
      if (op.type === "append" && op.body) {
        fileLines.push(...op.body);
      } else if (op.type === "after" && op.target !== undefined && op.body) {
        fileLines.splice(op.target, 0, ...op.body);
      } else if (op.type === "before" && op.target !== undefined && op.body) {
        const idx = Math.max(0, op.target - 1);
        fileLines.splice(idx, 0, ...op.body);
      } else if (op.type === "range" && op.start !== undefined && op.end !== undefined && op.body) {
        const startIdx = op.start - 1;
        const count = op.end - op.start + 1;
        fileLines.splice(startIdx, count, ...op.body);
      } else if (op.type === "cut" && op.start !== undefined && op.end !== undefined) {
        const startIdx = op.start - 1;
        const count = op.end - op.start + 1;
        fileLines.splice(startIdx, count);
      }
    }

    let nextContent = fileLines.join("\n");
    if (content.endsWith("\n") && !nextContent.endsWith("\n")) {
      nextContent += "\n";
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, nextContent, "utf-8");
    updatedFiles.push(resolvedPath);
  }

  return {
    success: true,
    updatedFiles,
    output: `Successfully applied hashline edits to: ${updatedFiles.join(", ")}`,
  };
}

function parseRange(spec: string): [number, number] {
  if (spec.includes(".=")) {
    const [s, e] = spec.split(".=");
    return [parseInt(s, 10), parseInt(e, 10)];
  }
  if (spec.includes("..")) {
    const [s, e] = spec.split("..");
    return [parseInt(s, 10), parseInt(e, 10)];
  }
  const n = parseInt(spec, 10);
  return [n, n];
}
