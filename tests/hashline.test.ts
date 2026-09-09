import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { computeSnapshotTag, applyHashlinePatch } from "../src/hashline";

describe("hashline editing engine", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("computes 4-hex snapshot tag deterministically", () => {
    const text = "export const answer = 42;\n";
    const tag1 = computeSnapshotTag(text);
    const tag2 = computeSnapshotTag(text);
    expect(tag1).toBe(tag2);
    expect(tag1.length).toBe(4);
  });

  it("applies PUT N.=M: range replacement", async () => {
    const filePath = path.join(tempDir, "service.ts");
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    await fs.writeFile(filePath, original);

    const tag = computeSnapshotTag(original);
    const patch = `*** Begin Patch\n[${filePath}#${tag}]\nPUT 2.=4:\n+replacement A\n+replacement B\n*** End Patch`;

    const result = await applyHashlinePatch(patch, tempDir);
    expect(result.success).toBe(true);
    expect(result.updatedFiles).toContain(filePath);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("line 1\nreplacement A\nreplacement B\nline 5\n");
  });

  it("applies PUT <N: and PUT >N: insertions", async () => {
    const filePath = path.join(tempDir, "items.ts");
    const original = "alpha\nbeta\ngamma\n";
    await fs.writeFile(filePath, original);

    const tag = computeSnapshotTag(original);
    const patch = `*** Begin Patch\n[${filePath}#${tag}]\nPUT <2:\n+before beta\nPUT >2:\n+after beta\n*** End Patch`;

    const result = await applyHashlinePatch(patch, tempDir);
    expect(result.success).toBe(true);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("alpha\nbefore beta\nbeta\nafter beta\ngamma\n");
  });

  it("applies CUT N.=M: deletion", async () => {
    const filePath = path.join(tempDir, "cleanup.ts");
    const original = "keep 1\ndelete 2\ndelete 3\nkeep 4\n";
    await fs.writeFile(filePath, original);

    const tag = computeSnapshotTag(original);
    const patch = `*** Begin Patch\n[${filePath}#${tag}]\nCUT 2.=3\n*** End Patch`;

    const result = await applyHashlinePatch(patch, tempDir);
    expect(result.success).toBe(true);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("keep 1\nkeep 4\n");
  });

  it("rejects patch on tag mismatch to prevent clobbering concurrent changes", async () => {
    const filePath = path.join(tempDir, "concurrent.ts");
    await fs.writeFile(filePath, "current on disk content\n");

    const patch = `*** Begin Patch\n[${filePath}#dead]\nPUT 1.=1:\n+new\n*** End Patch`;

    const result = await applyHashlinePatch(patch, tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Snapshot tag mismatch");
  });
});
