use serde::Deserialize;

type CommandResult<T> = Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPersistArtifactRequest {
    pub file_name: String,
    pub contents: String,
}

#[tauri::command]
pub fn debug_persist_artifact(request: DebugPersistArtifactRequest) -> CommandResult<String> {
    let file_name = sanitize_file_name(&request.file_name);
    if file_name.is_empty() {
        return Err("Debug artifact file name cannot be empty".to_string());
    }

    let artifact_dir = std::env::temp_dir().join("codex-session-monitor-debug");
    std::fs::create_dir_all(&artifact_dir).map_err(|error| error.to_string())?;

    let artifact_path = artifact_dir.join(file_name);
    std::fs::write(&artifact_path, request.contents).map_err(|error| error.to_string())?;

    Ok(artifact_path.display().to_string())
}

fn sanitize_file_name(input: &str) -> String {
    input.chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '_',
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}
