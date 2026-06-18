use serde::Serialize;
use sha2::{Digest, Sha256};

const MODEL_REVISION: &str = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const MODEL_URL: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/onnx/model.onnx";
const TOKENIZER_URL: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/tokenizer.json";
const MODEL_SHA256: &str = "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452";
const TOKENIZER_SHA256: &str = "0527a6e09e4ddafb203ce57d0b33383aca4727268810f6db490723892d49585d";

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual == expected {
        Ok(())
    } else {
        Err(format!("SHA-256 mismatch: expected {expected}, got {actual}"))
    }
}

#[cfg(not(test))]
fn verify_file(path: &std::path::Path, expected: &str) -> bool {
    std::fs::read(path)
        .ok()
        .is_some_and(|bytes| verify_sha256(&bytes, expected).is_ok())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub file_index: u8,
    pub file_count: u8,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub pct: Option<u8>,
}

pub fn compute_progress(
    received: u64,
    total: Option<u64>,
    file_index: u8,
    file_count: u8,
) -> DownloadProgress {
    let pct = total.map(|t| {
        if t == 0 {
            0u8
        } else {
            ((received.min(t) as f64 / t as f64) * 100.0) as u8
        }
    });
    DownloadProgress {
        file_index,
        file_count,
        received_bytes: received,
        total_bytes: total,
        pct,
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::verify_sha256;

    #[test]
    fn rejects_bytes_with_the_wrong_digest() {
        let error = verify_sha256(b"tampered", "0000000000000000000000000000000000000000000000000000000000000000")
            .expect_err("mismatched content must be rejected");
        assert!(error.contains("SHA-256"));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub downloaded: bool,
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

    let downloaded =
        verify_file(&model_path, MODEL_SHA256) && verify_file(&tokenizer_path, TOKENIZER_SHA256);
    let model_size_mb = std::fs::metadata(&model_path)
        .map(|m| m.len() as f32 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    Ok(ModelStatus {
        downloaded,
        model_size_mb,
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn download_local_embedding_model(
    app_handle: tauri::AppHandle,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    let dir = model_dir(&app_handle)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create model dir: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let files = [
        (MODEL_URL, "model.onnx", MODEL_SHA256),
        (TOKENIZER_URL, "tokenizer.json", TOKENIZER_SHA256),
    ];
    let file_count = files.len() as u8;
    let mut cumulative_received: u64 = 0;
    let mut cumulative_total: Option<u64> = Some(0);

    for (file_index, (url, file_name, expected_sha256)) in files.iter().enumerate() {
        let file_index = file_index as u8;
        let response = client
            .get(*url)
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

        let file_total: Option<u64> = response.content_length();
        cumulative_total = match (cumulative_total, file_total) {
            (Some(acc), Some(len)) => Some(acc + len),
            _ => None,
        };

        let tmp_path = dir.join(format!("{}.tmp", file_name));
        let final_path = dir.join(file_name);
        let mut file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Could not create {}: {}", file_name, e))?;

        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Read error for {}: {}", file_name, e))?
        {
            use std::io::Write;
            file.write_all(&chunk)
                .map_err(|e| format!("Write error for {}: {}", file_name, e))
                .inspect_err(|_| {
                    let _ = std::fs::remove_file(&tmp_path);
                })?;
            cumulative_received += chunk.len() as u64;

            let progress = compute_progress(
                cumulative_received,
                cumulative_total,
                file_index,
                file_count,
            );
            let _ = on_progress.send(progress);
        }
        drop(file);
        let bytes = std::fs::read(&tmp_path)
            .map_err(|e| format!("Could not verify {}: {}", file_name, e))?;
        verify_sha256(&bytes, expected_sha256).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("Integrity check failed for {file_name} at revision {MODEL_REVISION}: {e}")
        })?;

        std::fs::rename(&tmp_path, &final_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("Could not finalize {}: {}", file_name, e)
        })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_progress_monotonic() {
        let p1 = compute_progress(100, Some(1000), 0, 2);
        let p2 = compute_progress(500, Some(1000), 0, 2);
        let p3 = compute_progress(1000, Some(1000), 0, 2);
        assert!(p1.pct.unwrap() <= p2.pct.unwrap());
        assert!(p2.pct.unwrap() <= p3.pct.unwrap());
        assert_eq!(p3.pct.unwrap(), 100);
    }

    #[test]
    fn compute_progress_indeterminate() {
        let p = compute_progress(500, None, 0, 2);
        assert!(p.pct.is_none());
        assert!(p.total_bytes.is_none());
    }

    #[test]
    fn compute_progress_zero_total() {
        let p = compute_progress(0, Some(0), 0, 2);
        assert_eq!(p.pct.unwrap(), 0);
    }
}
