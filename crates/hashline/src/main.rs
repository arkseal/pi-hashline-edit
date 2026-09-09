use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process;

use hashline::{apply_patch_to_content, compute_snapshot_tag, parse_patch, HashlineOp};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_usage();
        process::exit(1);
    }

    match args[1].as_str() {
        "tag" => {
            if args.len() < 3 {
                eprintln!("Error: 'tag' requires a file path argument");
                process::exit(1);
            }
            let file_path = &args[2];
            match fs::read_to_string(file_path) {
                Ok(content) => {
                    println!("{}", compute_snapshot_tag(&content));
                }
                Err(e) => {
                    eprintln!("Error reading file {}: {}", file_path, e);
                    process::exit(1);
                }
            }
        }
        "apply" => {
            let mut patch_content = String::new();
            if args.len() >= 3 && args[2] == "--file" {
                if args.len() < 4 {
                    eprintln!("Error: --file requires a path");
                    process::exit(1);
                }
                patch_content = fs::read_to_string(&args[3]).unwrap_or_else(|e| {
                    eprintln!("Failed to read patch file: {}", e);
                    process::exit(1);
                });
            } else {
                io::stdin().read_to_string(&mut patch_content).unwrap_or_else(|e| {
                    eprintln!("Failed to read patch from stdin: {}", e);
                    process::exit(1);
                });
            }

            let patches = match parse_patch(&patch_content) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Failed to parse patch: {}", e);
                    process::exit(1);
                }
            };

            for patch in patches {
                let target_path = Path::new(&patch.file_path);

                // Handle file operations
                let mut should_remove = false;
                let mut move_dest: Option<String> = None;

                for op in &patch.ops {
                    match op {
                        HashlineOp::RemoveFile => should_remove = true,
                        HashlineOp::MoveFile { dest } => move_dest = Some(dest.clone()),
                        _ => {}
                    }
                }

                if should_remove {
                    if target_path.exists() {
                        fs::remove_file(target_path).unwrap_or_else(|e| {
                            eprintln!("Failed to delete {}: {}", patch.file_path, e);
                            process::exit(1);
                        });
                        println!("Deleted: {}", patch.file_path);
                    }
                    continue;
                }

                let original_content = if target_path.exists() {
                    fs::read_to_string(target_path).unwrap_or_else(|e| {
                        eprintln!("Failed to read {}: {}", patch.file_path, e);
                        process::exit(1);
                    })
                } else {
                    String::new()
                };

                let updated_content = match apply_patch_to_content(&original_content, &patch) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("Failed to apply patch to {}: {}", patch.file_path, e);
                        process::exit(1);
                    }
                };

                let dest_path = if let Some(ref dest) = move_dest {
                    if target_path.exists() {
                        let _ = fs::remove_file(target_path);
                    }
                    Path::new(dest)
                } else {
                    target_path
                };

                if let Some(parent) = dest_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }

                fs::write(dest_path, updated_content).unwrap_or_else(|e| {
                    eprintln!("Failed to write {}: {}", dest_path.display(), e);
                    process::exit(1);
                });

                let new_tag = compute_snapshot_tag(&fs::read_to_string(dest_path).unwrap_or_default());
                println!("Updated: {} (new tag: #{})", dest_path.display(), new_tag);
            }
        }
        "help" | "--help" | "-h" => {
            print_usage();
        }
        cmd => {
            eprintln!("Unknown command: {}", cmd);
            print_usage();
            process::exit(1);
        }
    }
}

fn print_usage() {
    println!("hashline - High performance hashline patch engine");
    println!("Usage:");
    println!("  hashline tag <file_path>           Compute 4-hex snapshot tag");
    println!("  hashline apply                     Apply patch from stdin");
    println!("  hashline apply --file <patch_file> Apply patch from file");
}
