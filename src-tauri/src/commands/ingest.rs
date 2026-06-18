use crate::*;

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn ingest_url(url: String) -> Result<IngestRaw, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL must use http:// or https://".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; Lattice/1.0; +https://github.com/lattice)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not fetch URL: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Could not fetch URL (status {})", status.as_u16()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let normalized_content_type = content_type.to_ascii_lowercase();
    if !normalized_content_type.contains("text/html") && !content_type.is_empty() {
        return Err(format!(
            "URL is not an HTML page (content-type {})",
            content_type
        ));
    }

    let html = response.text().await.map_err(|e| e.to_string())?;

    // Extract main content using readability
    let parsed_url: url::Url = url
        .parse()
        .map_err(|e| format!("Invalid URL: {}", e))?;
    let mut cursor = std::io::Cursor::new(html.as_bytes().to_vec());

    let product = readability::extractor::extract(&mut cursor, &parsed_url)
        .map_err(|_| "No readable content found at this URL".to_string())?;

    let text = strip_html_tags(&product.content);

    if text.trim().is_empty() {
        return Err("No readable content found at this URL".to_string());
    }

    if text.trim().chars().count() < MIN_EXTRACT_CHARS {
        return Err("Extraction too thin — page may require a browser".to_string());
    }

    let title = if product.title.trim().is_empty() {
        None
    } else {
        Some(product.title.trim().to_string())
    };

    Ok(IngestRaw {
        title,
        text: text.trim().to_string(),
        source_ref: url.clone(),
        source_type: "url".to_string(),
        ingest_date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
    })
}

#[cfg(not(test))]
#[tauri::command]
pub(crate) async fn ingest_pdf(path: String) -> Result<IngestRaw, String> {
    let text = std::panic::catch_unwind(|| pdf_extract::extract_text(&path))
        .map_err(|_| "PDF parsing caused a panic — file may be corrupt".to_string())?
        .map_err(|e| format!("Could not read PDF: {}", e))?;

    if text.trim().is_empty() {
        return Err("No extractable text (PDF may be scanned/image-only)".to_string());
    }

    if text.trim().chars().count() < MIN_EXTRACT_CHARS {
        return Err("Extraction too thin — page may require a browser".to_string());
    }

    let source_ref = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path)
        .to_string();

    Ok(IngestRaw {
        title: Some(source_ref.trim_end_matches(".pdf").to_string()),
        text: text.trim().to_string(),
        source_ref,
        source_type: "pdf".to_string(),
        ingest_date: chrono::Utc::now().format("%Y-%m-%d").to_string(),
    })
}
