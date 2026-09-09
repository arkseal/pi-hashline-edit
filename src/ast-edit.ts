import { execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AstEditParams {
  pattern: string;
  rewrite: string;
  path?: string;
  language?: string;
}

export interface AstEditResult {
  success: boolean;
  output: string;
  details: {
    pattern: string;
    rewrite: string;
  };
}

export async function executeAstEdit(
  params: AstEditParams,
  directory: string
): Promise<AstEditResult> {
  if (!params.pattern) throw new Error("pattern is required");
  if (!params.rewrite) throw new Error("rewrite is required");

  const targetPath = params.path
    ? path.isAbsolute(params.path)
      ? params.path
      : path.resolve(directory, params.path)
    : directory;

  const args = [
    "run",
    "--pattern",
    params.pattern,
    "--rewrite",
    params.rewrite,
    "--update-all",
  ];

  if (params.language) {
    args.push("--lang", params.language);
  }

  args.push(targetPath);

  try {
    const { stdout, stderr } = await execFileAsync("ast-grep", args, {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    });

    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      success: true,
      output: out || `ast_edit completed: transformed pattern '${params.pattern}' -> '${params.rewrite}' in ${path.relative(directory, targetPath) || "."}`,
      details: {
        pattern: params.pattern,
        rewrite: params.rewrite,
      },
    };
  } catch (err: any) {
    // If ast-grep binary isn't in PATH, check npx ast-grep or fallback
    try {
      const { stdout, stderr } = await execFileAsync("npx", ["@ast-grep/cli", ...args], {
        cwd: directory,
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      return {
        success: true,
        output: out || `ast_edit completed: transformed pattern '${params.pattern}' -> '${params.rewrite}' in ${path.relative(directory, targetPath) || "."}`,
        details: {
          pattern: params.pattern,
          rewrite: params.rewrite,
        },
      };
    } catch (fallbackErr: any) {
      const message = fallbackErr.stderr || fallbackErr.stdout || fallbackErr.message || err.message;
      return {
        success: false,
        output: `ast_edit failed: ${message.trim()}`,
        details: {
          pattern: params.pattern,
          rewrite: params.rewrite,
        },
      };
    }
  }
}
