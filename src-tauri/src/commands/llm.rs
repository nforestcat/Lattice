use crate::*;

fn parse_chat_response(provider: &str, data: &serde_json::Value) -> Result<String, String> {
    let value = match provider {
        "ollama" => data.pointer("/message/content"),
        "openai" | "lm-studio" | "custom" => data.pointer("/choices/0/message/content"),
        "gemini" => data.pointer("/candidates/0/content/parts/0/text"),
        "anthropic" => data.pointer("/content/0/text"),
        _ => return Err(format!("Unsupported provider: {provider}")),
    };
    value
        .and_then(serde_json::Value::as_str)
        .filter(|content| !content.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            let label = match provider {
                "openai" | "lm-studio" | "custom" => "OpenAI-compatible",
                "ollama" => "Ollama",
                "gemini" => "Gemini",
                "anthropic" => "Anthropic",
                _ => provider,
            };
            format!("Invalid response from {label} chat API")
        })
}

#[cfg(test)]
mod tests {
    use super::parse_chat_response;
    use serde_json::json;

    #[test]
    fn rejects_malformed_desktop_chat_responses() {
        let error = parse_chat_response("openai", &json!({"choices": [{"message": {}}]}))
            .expect_err("missing content must be rejected");
        assert!(error.contains("OpenAI-compatible"));
    }

    #[test]
    fn parses_valid_desktop_chat_responses() {
        let content = parse_chat_response(
            "anthropic",
            &json!({"content": [{"text": "validated response"}]}),
        )
        .expect("valid response");
        assert_eq!(content, "validated response");
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn save_api_key(provider: String, key: String) -> Result<(), String> {
    save_api_key_in_keyring(&provider, &key)
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) fn get_api_key(provider: String) -> Result<String, String> {
    Ok(get_api_key_from_keyring(&provider).unwrap_or_default())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn send_llm_chat_message(
    config: LlmConfig,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let api_key = get_api_key_from_keyring(&config.provider).unwrap_or(config.api_key);
    
    let client = reqwest::Client::new();
    
    match config.provider.as_str() {
        "ollama" => {
            let base = config.base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            let url = format!("{}/api/chat", base.trim_end_matches('/'));
            
            let response = client.post(&url)
                .json(&serde_json::json!({
                    "model": config.model,
                    "messages": messages,
                    "stream": false
                }))
                .send()
                .await
                .map_err(|e| format!("Ollama fetch error: {}", e))?;
                
            if !response.status().is_success() {
                return Err(format!("Ollama status error: {}", response.status()));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            parse_chat_response("ollama", &data)
        }
        "openai" | "lm-studio" | "custom" => {
            let default_base = if config.provider == "openai" {
                "https://api.openai.com/v1".to_string()
            } else if config.provider == "lm-studio" {
                "http://localhost:1234/v1".to_string()
            } else {
                "".to_string()
            };
            let base = config.base_url.unwrap_or(default_base);
            if base.is_empty() {
                return Err("Base URL is required".to_string());
            }
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            
            let mut request = client.post(&url);
            if !api_key.is_empty() {
                request = request.bearer_auth(&api_key);
            }
            
            let response = request
                .json(&serde_json::json!({
                    "model": config.model,
                    "messages": messages,
                    "stream": false
                }))
                .send()
                .await
                .map_err(|e| format!("API fetch error: {}", e))?;
                
            if !response.status().is_success() {
                let status = response.status();
                let err_text = response.text().await.unwrap_or_default();
                return Err(format!("API error status {}: {}", status, err_text));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            parse_chat_response(&config.provider, &data)
        }
        "gemini" => {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
                config.model, api_key
            );
            
            let system_msg = messages.iter().find(|m| m.role == "system").map(|m| m.content.clone());
            let conversation_msgs: Vec<_> = messages.iter().filter(|m| m.role != "system").collect();
            
            let contents: Vec<_> = conversation_msgs.iter().map(|m| {
                let role = if m.role == "assistant" { "model" } else { "user" };
                serde_json::json!({
                    "role": role,
                    "parts": [{"text": m.content}]
                })
            }).collect();
            
            let mut body = serde_json::json!({
                "contents": contents
            });
            
            if let Some(sys) = system_msg {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{"text": sys}]
                });
            }
            
            let response = client.post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Gemini API fetch error: {}", e))?;
                
            if !response.status().is_success() {
                let status = response.status();
                let err_text = response.text().await.unwrap_or_default();
                return Err(format!("Gemini API error status {}: {}", status, err_text));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            parse_chat_response("gemini", &data)
        }
        "anthropic" => {
            let url = "https://api.anthropic.com/v1/messages";
            let system_msg = messages.iter().find(|m| m.role == "system").map(|m| m.content.clone());
            let conversation_msgs: Vec<_> = messages.iter().filter(|m| m.role != "system").collect();
            
            let anthropic_messages: Vec<_> = conversation_msgs.iter().map(|m| {
                let role = if m.role == "assistant" { "assistant" } else { "user" };
                serde_json::json!({
                    "role": role,
                    "content": m.content
                })
            }).collect();
            
            let mut body = serde_json::json!({
                "model": config.model,
                "max_tokens": 4000,
                "messages": anthropic_messages
            });
            
            if let Some(sys) = system_msg {
                body["system"] = serde_json::json!(sys);
            }
            
            let response = client.post(url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Anthropic API fetch error: {}", e))?;
                
            if !response.status().is_success() {
                let status = response.status();
                let err_text = response.text().await.unwrap_or_default();
                return Err(format!("Anthropic API error status {}: {}", status, err_text));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            parse_chat_response("anthropic", &data)
        }
        _ => Err(format!("Unsupported provider: {}", config.provider))
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn get_llm_embedding(
    config: LlmConfig,
    text: String,
) -> Result<Vec<f32>, String> {
    let provider = config
        .embedding_provider
        .as_deref()
        .filter(|value| *value != "local-onnx")
        .unwrap_or(&config.provider);
    let api_key = get_api_key_from_keyring(provider).unwrap_or(config.api_key);
    
    let client = reqwest::Client::new();
    let model = config.embedding_model.clone().unwrap_or_else(|| {
        if provider == "openai" {
            "text-embedding-3-small".to_string()
        } else {
            "all-minilm".to_string()
        }
    });
    
    let sanitized_text = text.trim();
    if sanitized_text.is_empty() {
        return Ok(vec![]);
    }
    
    match provider {
        "ollama" => {
            let base = if config.provider == provider {
                config.base_url.unwrap_or_else(|| "http://localhost:11434".to_string())
            } else {
                "http://localhost:11434".to_string()
            };
            let url = format!("{}/api/embeddings", base.trim_end_matches('/'));
            
            let response = client.post(&url)
                .json(&serde_json::json!({
                    "model": model,
                    "prompt": sanitized_text
                }))
                .send()
                .await
                .map_err(|e| format!("Ollama embedding error: {}", e))?;
                
            if !response.status().is_success() {
                return Err(format!("Ollama embedding status: {}", response.status()));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["embedding"].as_array() {
                let vec: Result<Vec<f32>, _> = arr.iter().map(|v| v.as_f64().map(|f| f as f32).ok_or("Not a float")).collect();
                return vec.map_err(|e| e.to_string());
            }
            Err("Invalid response format".to_string())
        }
        "openai" | "lm-studio" | "custom" => {
            let default_base = if provider == "openai" {
                "https://api.openai.com/v1".to_string()
            } else if provider == "lm-studio" {
                "http://localhost:1234/v1".to_string()
            } else {
                "".to_string()
            };
            let base = if config.provider == provider {
                config.base_url.unwrap_or(default_base)
            } else {
                default_base
            };
            if base.is_empty() {
                return Err("Base URL is required".to_string());
            }
            let url = format!("{}/embeddings", base.trim_end_matches('/'));
            
            let mut request = client.post(&url);
            if !api_key.is_empty() {
                request = request.bearer_auth(&api_key);
            }
            
            let response = request
                .json(&serde_json::json!({
                    "model": model,
                    "input": sanitized_text
                }))
                .send()
                .await
                .map_err(|e| format!("Embedding fetch error: {}", e))?;
                
            if !response.status().is_success() {
                let status = response.status();
                let err_text = response.text().await.unwrap_or_default();
                return Err(format!("Embedding status error {}: {}", status, err_text));
            }
            
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["data"][0]["embedding"].as_array() {
                let vec: Result<Vec<f32>, _> = arr.iter().map(|v| v.as_f64().map(|f| f as f32).ok_or("Not a float")).collect();
                return vec.map_err(|e| e.to_string());
            }
            Err("Invalid response format".to_string())
        }
        _ => Err(format!("Embeddings not supported for provider: {}", provider))
    }
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn fetch_provider_models(
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let api_key = get_api_key_from_keyring(&provider).unwrap_or_default();
    let client = reqwest::Client::new();
    
    match provider.as_str() {
        "openai" => {
            let response = client.get("https://api.openai.com/v1/models")
                .bearer_auth(&api_key)
                .send()
                .await
                .map_err(|e| format!("OpenAI models fetch error: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("OpenAI models error: {}", response.status()));
            }
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["data"].as_array() {
                let models: Vec<String> = arr.iter().filter_map(|m| m["id"].as_str().map(|s| s.to_string())).collect();
                return Ok(models);
            }
            Ok(vec![])
        }
        "ollama" => {
            let base = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
            let url = format!("{}/api/tags", base.trim_end_matches('/'));
            let response = client.get(&url)
                .send()
                .await
                .map_err(|e| format!("Ollama fetch error: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("Ollama status error: {}", response.status()));
            }
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["models"].as_array() {
                let models: Vec<String> = arr.iter().filter_map(|m| m["name"].as_str().map(|s| s.to_string())).collect();
                return Ok(models);
            }
            Ok(vec![])
        }
        "lm-studio" | "custom" => {
            let default_base = if provider == "lm-studio" {
                "http://localhost:1234/v1".to_string()
            } else {
                "".to_string()
            };
            let base = base_url.unwrap_or(default_base);
            if base.is_empty() {
                return Ok(vec![]);
            }
            let url = format!("{}/models", base.trim_end_matches('/'));
            let mut request = client.get(&url);
            if !api_key.is_empty() {
                request = request.bearer_auth(&api_key);
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("Models fetch error: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("Models status error: {}", response.status()));
            }
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["data"].as_array() {
                let models: Vec<String> = arr.iter().filter_map(|m| m["id"].as_str().map(|s| s.to_string())).collect();
                return Ok(models);
            }
            Ok(vec![])
        }
        "gemini" => {
            let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", api_key);
            let response = client.get(&url)
                .send()
                .await
                .map_err(|e| format!("Gemini fetch error: {}", e))?;
            if !response.status().is_success() {
                return Err(format!("Gemini status error: {}", response.status()));
            }
            let data: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            if let Some(arr) = data["models"].as_array() {
                let models: Vec<String> = arr.iter()
                    .filter_map(|m| m["name"].as_str())
                    .map(|s| s.strip_prefix("models/").unwrap_or(s).to_string())
                    .collect();
                return Ok(models);
            }
            Ok(vec![])
        }
        "anthropic" => {
            Ok(vec![
                "claude-3-5-sonnet-20241022".to_string(),
                "claude-3-5-sonnet-20240620".to_string(),
                "claude-3-5-haiku-20241022".to_string(),
                "claude-3-opus-20240229".to_string(),
                "claude-3-haiku-20240307".to_string(),
            ])
        }
        _ => Ok(vec![])
    }
}
