use crc32fast::Hasher;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, PartialEq, Eq, Clone, Serialize, Deserialize)]
pub enum HashlineOp {
    PutRange {
        start: usize,
        end: usize,
        body: Vec<String>,
    },
    PutBefore {
        target: usize,
        body: Vec<String>,
    },
    PutAfter {
        target: usize,
        body: Vec<String>,
    },
    PutAppend {
        body: Vec<String>,
    },
    CutRange {
        start: usize,
        end: usize,
    },
    RemoveFile,
    MoveFile {
        dest: String,
    },
}

#[derive(Debug, PartialEq, Eq, Clone, Serialize, Deserialize)]
pub struct FilePatch {
    pub file_path: String,
    pub expected_tag: Option<String>,
    pub ops: Vec<HashlineOp>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HashlineError {
    EmptyPatch,
    InvalidHeader(String),
    InvalidOp(String),
    TagMismatch { expected: String, actual: String },
    LineOutOfBounds { line: usize, total_lines: usize },
    InvalidRange { start: usize, end: usize },
}

impl fmt::Display for HashlineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPatch => write!(f, "Empty patch: no operations specified"),
            Self::InvalidHeader(h) => write!(f, "Invalid patch header: {}", h),
            Self::InvalidOp(o) => write!(f, "Invalid hashline operation: {}", o),
            Self::TagMismatch { expected, actual } => {
                write!(f, "Snapshot tag mismatch: expected #{}, but file content has #{}", expected, actual)
            }
            Self::LineOutOfBounds { line, total_lines } => {
                write!(f, "Line {} out of bounds (file has {} lines)", line, total_lines)
            }
            Self::InvalidRange { start, end } => {
                write!(f, "Invalid line range: {}..{}", start, end)
            }
        }
    }
}

impl std::error::Error for HashlineError {}

/// Compute 4-hex snapshot tag for file content.
pub fn compute_snapshot_tag(content: &str) -> String {
    let mut hasher = Hasher::new();
    hasher.update(content.as_bytes());
    let checksum = hasher.finalize();
    format!("{:04x}", checksum & 0xffff)
}

/// Parse a hashline patch text into a list of FilePatches.
pub fn parse_patch(patch_text: &str) -> Result<Vec<FilePatch>, HashlineError> {
    let lines: Vec<&str> = patch_text.lines().map(|l| l.trim_end()).collect();
    if lines.is_empty() {
        return Err(HashlineError::EmptyPatch);
    }

    let mut patches = Vec::new();
    let mut current_patch: Option<FilePatch> = None;
    let mut current_op: Option<HashlineOp> = None;
    let mut in_envelope = false;

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        if line == "*** Begin Patch" {
            in_envelope = true;
            i += 1;
            continue;
        }
        if line == "*** End Patch" {
            break;
        }

        if !in_envelope && !line.starts_with('[') {
            i += 1;
            continue;
        }

        // File header: [PATH#TAG] or [PATH]
        if line.starts_with('[') && line.ends_with(']') {
            // Flush prior op and patch
            if let Some(op) = current_op.take() {
                if let Some(p) = current_patch.as_mut() {
                    p.ops.push(op);
                }
            }
            if let Some(p) = current_patch.take() {
                patches.push(p);
            }

            let inner = &line[1..line.len() - 1];
            let (file_path, expected_tag) = if let Some(hash_idx) = inner.rfind('#') {
                (
                    inner[..hash_idx].trim().to_string(),
                    Some(inner[hash_idx + 1..].trim().to_string()),
                )
            } else {
                (inner.trim().to_string(), None)
            };

            current_patch = Some(FilePatch {
                file_path,
                expected_tag,
                ops: Vec::new(),
            });
            i += 1;
            continue;
        }

        // Check operations
        if line.starts_with("PUT ") || line.starts_with("CUT ") || line == "REM" || line.starts_with("MV ") {
            if let Some(op) = current_op.take() {
                if let Some(p) = current_patch.as_mut() {
                    p.ops.push(op);
                }
            }

            if line == "REM" {
                current_op = Some(HashlineOp::RemoveFile);
            } else if let Some(dest) = line.strip_prefix("MV ") {
                current_op = Some(HashlineOp::MoveFile {
                    dest: dest.trim().to_string(),
                });
            } else if let Some(cut_spec) = line.strip_prefix("CUT ") {
                let range = parse_line_range(cut_spec.trim())?;
                current_op = Some(HashlineOp::CutRange {
                    start: range.0,
                    end: range.1,
                });
            } else if let Some(put_spec) = line.strip_prefix("PUT ") {
                let spec = put_spec.trim_end_matches(':').trim();
                if spec.starts_with('<') {
                    let target = spec[1..]
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| HashlineError::InvalidOp(line.to_string()))?;
                    current_op = Some(HashlineOp::PutBefore {
                        target,
                        body: Vec::new(),
                    });
                } else if spec.starts_with('>') {
                    let rest = &spec[1..].trim();
                    if *rest == "$" {
                        current_op = Some(HashlineOp::PutAppend { body: Vec::new() });
                    } else {
                        let target = rest
                            .parse::<usize>()
                            .map_err(|_| HashlineError::InvalidOp(line.to_string()))?;
                        current_op = Some(HashlineOp::PutAfter {
                            target,
                            body: Vec::new(),
                        });
                    }
                } else {
                    let (start, end) = parse_line_range(spec)?;
                    current_op = Some(HashlineOp::PutRange {
                        start,
                        end,
                        body: Vec::new(),
                    });
                }
            }
            i += 1;
            continue;
        }

        // Replacement body line (starts with '+')
        if lines[i].starts_with('+') {
            let body_line = &lines[i][1..]; // preserve leading space of the replacement content
            match current_op.as_mut() {
                Some(HashlineOp::PutRange { body, .. })
                | Some(HashlineOp::PutBefore { body, .. })
                | Some(HashlineOp::PutAfter { body, .. })
                | Some(HashlineOp::PutAppend { body }) => {
                    body.push(body_line.to_string());
                }
                _ => {
                    return Err(HashlineError::InvalidOp(format!(
                        "Encountered '+' line without active PUT operation: {}",
                        lines[i]
                    )));
                }
            }
            i += 1;
            continue;
        }

        i += 1;
    }

    if let Some(op) = current_op.take() {
        if let Some(p) = current_patch.as_mut() {
            p.ops.push(op);
        }
    }
    if let Some(p) = current_patch.take() {
        patches.push(p);
    }

    if patches.is_empty() {
        return Err(HashlineError::EmptyPatch);
    }

    Ok(patches)
}

fn parse_line_range(spec: &str) -> Result<(usize, usize), HashlineError> {
    // Accepts forms: "3.=5", "3..5", "3-5", "3"
    let spec = spec.trim();
    if let Some((s, e)) = spec.split_once(".=") {
        let start = s.trim().parse::<usize>().map_err(|_| HashlineError::InvalidOp(spec.to_string()))?;
        let end = e.trim().parse::<usize>().map_err(|_| HashlineError::InvalidOp(spec.to_string()))?;
        Ok((start, end))
    } else if let Some((s, e)) = spec.split_once("..") {
        let start = s.trim().parse::<usize>().map_err(|_| HashlineError::InvalidOp(spec.to_string()))?;
        let end = e.trim().parse::<usize>().map_err(|_| HashlineError::InvalidOp(spec.to_string()))?;
        Ok((start, end))
    } else if let Ok(single) = spec.parse::<usize>() {
        Ok((single, single))
    } else {
        Err(HashlineError::InvalidOp(format!("Invalid range syntax: {}", spec)))
    }
}

/// Apply a single FilePatch to the original content string.
pub fn apply_patch_to_content(content: &str, patch: &FilePatch) -> Result<String, HashlineError> {
    // 1. Verify snapshot tag if specified
    if let Some(ref expected) = patch.expected_tag {
        let actual = compute_snapshot_tag(content);
        if expected.to_lowercase() != actual.to_lowercase() {
            return Err(HashlineError::TagMismatch {
                expected: expected.clone(),
                actual,
            });
        }
    }

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    // Sort operations from highest line number to lowest so line indices stay stable
    // when replacing/inserting/cutting
    let mut sorted_ops = patch.ops.clone();
    sorted_ops.sort_by_key(|op| match op {
        HashlineOp::PutAppend { .. } => usize::MAX,
        HashlineOp::PutAfter { target, .. } => *target * 2 + 1,
        HashlineOp::PutRange { start, .. } => *start * 2,
        HashlineOp::PutBefore { target, .. } => *target * 2,
        HashlineOp::CutRange { start, .. } => *start * 2,
        HashlineOp::MoveFile { .. } | HashlineOp::RemoveFile => 0,
    });
    sorted_ops.reverse();

    for op in sorted_ops {
        match op {
            HashlineOp::PutAppend { body } => {
                lines.extend(body);
            }
            HashlineOp::PutAfter { target, body } => {
                if target > lines.len() {
                    return Err(HashlineError::LineOutOfBounds {
                        line: target,
                        total_lines: lines.len(),
                    });
                }
                for (idx, body_line) in body.into_iter().enumerate() {
                    lines.insert(target + idx, body_line);
                }
            }
            HashlineOp::PutBefore { target, body } => {
                if target == 0 || target > lines.len() + 1 {
                    return Err(HashlineError::LineOutOfBounds {
                        line: target,
                        total_lines: lines.len(),
                    });
                }
                let insert_pos = target - 1;
                for (idx, body_line) in body.into_iter().enumerate() {
                    lines.insert(insert_pos + idx, body_line);
                }
            }
            HashlineOp::PutRange { start, end, body } => {
                if start == 0 || start > end || end > lines.len() {
                    return Err(HashlineError::InvalidRange { start, end });
                }
                // Drain the range [start-1 .. end]
                let start_idx = start - 1;
                let remove_count = end - start + 1;
                lines.drain(start_idx..start_idx + remove_count);
                // Splice new body
                for (idx, body_line) in body.into_iter().enumerate() {
                    lines.insert(start_idx + idx, body_line);
                }
            }
            HashlineOp::CutRange { start, end } => {
                if start == 0 || start > end || end > lines.len() {
                    return Err(HashlineError::InvalidRange { start, end });
                }
                let start_idx = start - 1;
                let remove_count = end - start + 1;
                lines.drain(start_idx..start_idx + remove_count);
            }
            HashlineOp::RemoveFile | HashlineOp::MoveFile { .. } => {}
        }
    }

    let mut result = lines.join("\n");
    if content.ends_with('\n') && !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_snapshot_tag() {
        let tag1 = compute_snapshot_tag("hello world\n");
        let tag2 = compute_snapshot_tag("hello world\n");
        let tag3 = compute_snapshot_tag("different content\n");

        assert_eq!(tag1.len(), 4);
        assert_eq!(tag1, tag2);
        assert_ne!(tag1, tag3);
    }

    #[test]
    fn test_parse_and_apply_put_range() {
        let initial = "line 1\nline 2\nline 3\nline 4\nline 5\n";
        let tag = compute_snapshot_tag(initial);

        let patch_text = format!(
            "*** Begin Patch\n[src/app.ts#{}]\nPUT 2.=4:\n+replacement line A\n+replacement line B\n*** End Patch",
            tag
        );

        let patches = parse_patch(&patch_text).expect("parse failed");
        assert_eq!(patches.len(), 1);
        let updated = apply_patch_to_content(initial, &patches[0]).expect("apply failed");

        assert_eq!(
            updated,
            "line 1\nreplacement line A\nreplacement line B\nline 5\n"
        );
    }

    #[test]
    fn test_put_before_and_after() {
        let initial = "first\nsecond\nthird\n";
        let tag = compute_snapshot_tag(initial);

        let patch_text = format!(
            "*** Begin Patch\n[file.txt#{}]\nPUT <2:\n+inserted before second\nPUT >2:\n+inserted after second\n*** End Patch",
            tag
        );

        let patches = parse_patch(&patch_text).expect("parse failed");
        let updated = apply_patch_to_content(initial, &patches[0]).expect("apply failed");

        assert_eq!(
            updated,
            "first\ninserted before second\nsecond\ninserted after second\nthird\n"
        );
    }

    #[test]
    fn test_cut_range() {
        let initial = "line 1\nline 2 to delete\nline 3 to delete\nline 4\n";
        let tag = compute_snapshot_tag(initial);

        let patch_text = format!(
            "*** Begin Patch\n[file.txt#{}]\nCUT 2.=3\n*** End Patch",
            tag
        );

        let patches = parse_patch(&patch_text).expect("parse failed");
        let updated = apply_patch_to_content(initial, &patches[0]).expect("apply failed");

        assert_eq!(updated, "line 1\nline 4\n");
    }

    #[test]
    fn test_tag_mismatch_error() {
        let initial = "original code\n";
        let patch_text = "*** Begin Patch\n[file.txt#dead]\nPUT 1.=1:\n+new code\n*** End Patch";

        let patches = parse_patch(patch_text).expect("parse failed");
        let err = apply_patch_to_content(initial, &patches[0]).unwrap_err();

        match err {
            HashlineError::TagMismatch { expected, .. } => assert_eq!(expected, "dead"),
            _ => panic!("Expected TagMismatch error"),
        }
    }
}
