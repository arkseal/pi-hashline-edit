import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { executeAstEdit } from "../src/ast-edit";

describe("ast-edit tool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-test-"));
    await fs.writeFile(
      path.join(tempDir, "test.js"),
      "console.log('first');\nconsole.log('second');\n"
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("validates required parameters", async () => {
    expect(executeAstEdit({ pattern: "", rewrite: "foo" }, tempDir)).rejects.toThrow("pattern is required");
    expect(executeAstEdit({ pattern: "foo", rewrite: "" }, tempDir)).rejects.toThrow("rewrite is required");
  });

  it("performs structural transformation on code files", async () => {
    const result = await executeAstEdit(
      {
        pattern: "console.log($A)",
        rewrite: "logger.info($A)",
        path: "test.js",
        language: "javascript",
      },
      tempDir
    );

    expect(result.details.pattern).toBe("console.log($A)");
    // If ast-grep is installed on the machine, the file is modified
    const file = await fs.readFile(path.join(tempDir, "test.js"), "utf-8");
    if (result.success) {
      expect(file).toContain("logger.info");
    }
  });
});
