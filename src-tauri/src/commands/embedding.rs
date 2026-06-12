use serde::Serialize;

const MODEL_URL: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx";
const TOKENIZER_URL: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub downloaded: bool,
    pub downloading: bool,
    pub progress_pct: Option<f32>,
    pub model_size_mb: f32,
}

#[cfg(not(test))]
fn model_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {}", e))?;
    Ok(base.join("lattice").join("models").join("all-minilm-l6-v2"))
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn get_local_embedding_model_status(
    app_handle: tauri::AppHandle,
) -> Result<ModelStatus, String> {
    let dir = model_dir(&app_handle)?;
    let model_path = dir.join("model.onnx");
    let tokenizer_path = dir.join("tokenizer.json");

    let downloaded = model_path.exists() && tokenizer_path.exists();
    let model_size_mb = std::fs::metadata(&model_path)
        .map(|m| m.len() as f32 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    Ok(ModelStatus {
        downloaded,
        downloading: false,
        progress_pct: None,
        model_size_mb,
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn download_local_embedding_model(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let dir = model_dir(&app_handle)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create model dir: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    for (url, file_name) in [(MODEL_URL, "model.onnx"), (TOKENIZER_URL, "tokenizer.json")] {
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Download failed for {}: {}", file_name, e))?;
        if !response.status().is_success() {
            return Err(format!(
                "Download failed for {} (status {})",
                file_name,
                response.status().as_u16()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Could not read {}: {}", file_name, e))?;
        std::fs::write(dir.join(file_name), &bytes)
            .map_err(|e| format!("Could not write {}: {}", file_name, e))?;
    }

    Ok(())
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn get_local_embedding(
    text: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<f32>, String> {
    use ndarray::Array2;
    use ort::session::Session;
    use ort::value::Tensor;

    let dir = model_dir(&app_handle)?;
    let model_path = dir.join("model.onnx");
    let tokenizer_path = dir.join("tokenizer.json");

    if !model_path.exists() || !tokenizer_path.exists() {
        return Err("Model not downloaded. Call download_local_embedding_model first.".to_string());
    }

    let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("Could not load tokenizer: {}", e))?;
    let encoding = tokenizer
        .encode(text, true)
        .map_err(|e| format!("Tokenization failed: {}", e))?;

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&v| v as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&v| v as i64)
        .collect();
    let type_ids: Vec<i64> = encoding
        .get_type_ids()
        .iter()
        .map(|&v| v as i64)
        .collect();
    let seq_len = ids.len();
    if seq_len == 0 {
        return Err("Empty tokenization result".to_string());
    }

    let mut session = Session::builder()
        .map_err(|e| e.to_string())?
        .commit_from_file(&model_path)
        .map_err(|e| format!("Could not load ONNX model: {}", e))?;

    // Some exports omit token_type_ids; only supply inputs the model declares
    // so name mismatches don't error.
    let input_ids = Array2::from_shape_vec((1, seq_len), ids.clone())
        .map_err(|e| e.to_string())?;
    let attention_mask = Array2::from_shape_vec((1, seq_len), mask.clone())
        .map_err(|e| e.to_string())?;
    let token_type_ids = Array2::from_shape_vec((1, seq_len), type_ids)
        .map_err(|e| e.to_string())?;

    let mut session_inputs: Vec<(std::borrow::Cow<str>, ort::session::SessionInputValue)> = Vec::new();
    for input in session.inputs() {
        let name = input.name();
        let tensor = match name {
            "input_ids" => Tensor::from_array(input_ids.clone()).map_err(|e| e.to_string())?,
            "attention_mask" => {
                Tensor::from_array(attention_mask.clone()).map_err(|e| e.to_string())?
            }
            "token_type_ids" => {
                Tensor::from_array(token_type_ids.clone()).map_err(|e| e.to_string())?
            }
            _ => continue,
        };
        session_inputs.push((name.to_string().into(), tensor.into()));
    }

    let output_name = session
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or("Model has no outputs")?;

    let outputs = session
        .run(session_inputs)
        .map_err(|e| format!("Inference failed: {}", e))?;

    let (shape, data) = outputs[output_name.as_str()]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Could not extract output tensor: {}", e))?;

    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    if dims.len() != 3 {
        return Err(format!(
            "Unexpected output shape {:?}, expected [1, seq_len, hidden]",
            dims
        ));
    }
    let out_seq = dims[1];
    let hidden = dims[2];

    let mut pooled = vec![0.0f32; hidden];
    let mut mask_sum = 0.0f32;
    for t in 0..out_seq {
        let m = mask.get(t).copied().unwrap_or(0) as f32;
        if m == 0.0 {
            continue;
        }
        mask_sum += m;
        let base = t * hidden;
        for h in 0..hidden {
            pooled[h] += data[base + h] * m;
        }
    }
    if mask_sum == 0.0 {
        return Err("Attention mask is all zeros".to_string());
    }
    for value in pooled.iter_mut() {
        *value /= mask_sum;
    }

    let norm: f32 = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in pooled.iter_mut() {
            *value /= norm;
        }
    }

    Ok(pooled)
}
