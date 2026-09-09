# pi-hashline-edit

High-efficiency hashline edit engine implemented in **Rust** (with full TypeScript bindings) and `ast-edit` structural rewriting for the **pi** coding agent.

## Why Hashline Edits Save 40–60% Tokens

Standard coding agent edits repeat 10–20 lines of unchanged code (`oldText` in string replacement, or unified diff context lines `@@`). Output tokens are the most expensive and slowest token type.

With Hashline editing (originated in `oh-my-pi`):
1. When files are read, a 4-hex snapshot tag is computed (e.g. `[src/auth.ts#a1f4]`).
2. The agent outputs **only** the targeted lines and replacement text:
   ```text
   *** Begin Patch
   [src/auth.ts#a1f4]
   PUT 14.=18:
   +const user = await authenticate(token);
   +if (!user) throw new AuthError();
   *** End Patch
   ```
3. Zero `oldText` or context lines are emitted.
4. If file content changed since the last read, the 4-hex tag mismatch prevents corrupting the file.

## Operations

- `PUT N.=M:` — Replaces lines N through M (inclusive) with `+` body lines
- `PUT <N:` — Inserts lines before line N
- `PUT >N:` — Inserts lines after line N
- `PUT >$:` — Appends lines to the end of the file
- `CUT N.=M` — Deletes lines N through M
- `REM` — Deletes the file
- `MV DEST` — Renames or moves the file

## Structural Rewriting (`ast_edit`)

Uses `ast-grep` for syntax-aware code modifications without fragile regexes:
```json
{
  "pattern": "console.log($MSG)",
  "rewrite": "logger.debug($MSG)",
  "language": "typescript"
}
```

## Rust Engine

The core hashline parser and line-replacement engine is written in Rust under `crates/hashline`.
To build or test:
```bash
cd crates/hashline
cargo test
cargo build --release
```

## Running Extension Tests

```bash
bun test
```
