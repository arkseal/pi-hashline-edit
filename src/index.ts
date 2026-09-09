import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyHashlinePatch, computeSnapshotTag } from "./hashline.js";
import { executeAstEdit } from "./ast-edit.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export { applyHashlinePatch, computeSnapshotTag } from "./hashline.js";
export { executeAstEdit } from "./ast-edit.js";

const HASHLINE_DESCRIPTION = `High-efficiency hashline patch editor. Saves 40-60% output tokens by omitting unchanged context and old code.
Format:
*** Begin Patch
[path/to/file#TAG]
PUT 14.=18:
+replacement code line 1
+replacement code line 2
PUT <5:
+line inserted before line 5
PUT >10:
+line inserted after line 10
CUT 30.=35
*** End Patch

Ops:
- PUT N.=M: Replaces inclusive lines N..M with '+' body
- PUT <N: Inserts before line N
- PUT >N: Inserts after line N
- PUT >$: Appends to end of file
- CUT N.=M: Deletes lines N..M
TAG is the 4-hex snapshot tag visible when reading/searching files.`;

export default function hashlineEditExtension(pi: ExtensionAPI) {
  // 1. Register hashline_edit tool
  pi.registerTool({
    name: "hashline_edit",
    label: "Hashline Edit",
    description: HASHLINE_DESCRIPTION,
    promptSnippet: "Edit files with token-efficient hashline patches (PUT N.=M:, CUT, etc.)",
    parameters: Type.Object(
      {
        patchText: Type.String({
          description: "The hashline patch text specifying file headers [file#tag] and operations",
        }),
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await applyHashlinePatch(params.patchText, ctx.cwd);
      return {
        content: [{ type: "text", text: result.output }],
        details: {
          success: result.success,
          updatedFiles: result.updatedFiles,
          error: result.error,
        },
      };
    },
  });

  // 2. Register ast_edit tool
  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description:
      "Structural syntax-aware code rewrite using ast-grep. Transforms pattern matches into rewrite template.",
    promptSnippet: "Syntax-aware pattern search and replace across files",
    parameters: Type.Object(
      {
        pattern: Type.String({
          description: "ast-grep structural pattern to match (e.g. 'console.log($A)')",
        }),
        rewrite: Type.String({
          description: "Replacement pattern template (e.g. 'logger.info($A)')",
        }),
        path: Type.Optional(
          Type.String({
            description: "Directory or file to transform. Defaults to current directory.",
          })
        ),
        language: Type.Optional(
          Type.String({
            description: "Target programming language (e.g. 'ts', 'js', 'py', 'rs', 'go')",
          })
        ),
      },
      { additionalProperties: false }
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await executeAstEdit(params, ctx.cwd);
      return {
        content: [{ type: "text", text: result.output }],
        details: result.details,
      };
    },
  });

  // 3. Decorate file read results with [path#tag] headers so the model knows the current tag
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || !event.input?.path) return;

    try {
      const filePath = String(event.input.path);
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
      const content = await fs.readFile(absPath, "utf-8");
      const tag = computeSnapshotTag(content);
      const relPath = path.relative(ctx.cwd, absPath).replaceAll("\\", "/");

      const header = `[${relPath}#${tag}]\n`;
      if (Array.isArray(event.content)) {
        for (const item of event.content) {
          if (item.type === "text" && typeof item.text === "string") {
            if (!item.text.startsWith("[")) {
              item.text = header + item.text;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  });
}
