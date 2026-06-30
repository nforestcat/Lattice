use crate::models::{LlmConfig, NoteTemplate, PromptRun, PromptTemplate, VaultConfig};
use std::collections::HashMap;

pub(crate) fn migrate_config(mut config: VaultConfig) -> VaultConfig {
    if config.version.map_or(true, |v| v < 1) {
        config.version = Some(1);
    }
    if config.context_limit.is_none() {
        config.context_limit = Some(8000);
    }
    if config.bundle_preset.is_none() {
        config.bundle_preset = Some("ask".to_string());
    }
    if config.bundle_mode.is_none() {
        config.bundle_mode = Some("standard".to_string());
    }
    if config.selected_paths.is_none() {
        config.selected_paths = Some(HashMap::new());
    }
    if config.prompt_instructions.is_none() {
        config.prompt_instructions = Some(HashMap::new());
    }
    if config.prompt_runs.is_none() {
        config.prompt_runs = Some(Vec::new());
    }
    if config.prompt_templates.is_none() {
        config.prompt_templates = Some(Vec::new());
    }
    config
}

pub(crate) fn vault_config_from_json(content: &str) -> VaultConfig {
    let value: serde_json::Value = match serde_json::from_str(content) {
        Ok(value) => value,
        Err(_) => return VaultConfig::default(),
    };
    let Some(object) = value.as_object() else {
        return VaultConfig::default();
    };

    VaultConfig {
        version: object
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok()),
        context_limit: object
            .get("contextLimit")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok()),
        bundle_preset: object
            .get("bundlePreset")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        bundle_purpose: object
            .get("bundlePurpose")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        bundle_mode: object
            .get("bundleMode")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        selected_paths: object
            .get("selectedPaths")
            .and_then(string_array_map_from_value),
        prompt_instructions: object
            .get("promptInstructions")
            .and_then(string_map_from_value),
        prompt_runs: object.get("promptRuns").and_then(|value| {
            value.as_array().map(|runs| {
                runs.iter()
                    .filter_map(|run| serde_json::from_value::<PromptRun>(run.clone()).ok())
                    .collect::<Vec<_>>()
            })
        }),
        prompt_templates: object.get("promptTemplates").and_then(|value| {
            value.as_array().map(|templates| {
                templates
                    .iter()
                    .filter_map(|template| {
                        serde_json::from_value::<PromptTemplate>(template.clone()).ok()
                    })
                    .collect::<Vec<_>>()
            })
        }),
        llm_config: object
            .get("llmConfig")
            .and_then(|value| serde_json::from_value::<LlmConfig>(value.clone()).ok()),
        archive_retention_policy: object
            .get("archiveRetentionPolicy")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        note_templates: object.get("noteTemplates").and_then(|value| {
            value.as_array().map(|templates| {
                templates
                    .iter()
                    .filter_map(|template| {
                        serde_json::from_value::<NoteTemplate>(template.clone()).ok()
                    })
                    .collect::<Vec<_>>()
            })
        }),
    }
}

fn string_map_from_value(value: &serde_json::Value) -> Option<HashMap<String, String>> {
    value.as_object().map(|object| {
        object
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
            .collect()
    })
}

fn string_array_map_from_value(value: &serde_json::Value) -> Option<HashMap<String, Vec<String>>> {
    value.as_object().map(|object| {
        object
            .iter()
            .filter_map(|(key, value)| {
                value.as_array().map(|items| {
                    let paths = items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect();
                    (key.clone(), paths)
                })
            })
            .collect()
    })
}
