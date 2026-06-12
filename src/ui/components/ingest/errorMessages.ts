export function mapErrorMessage(err: string): string {
  if (err.includes("Could not fetch URL (status 4"))
    return "페이지를 찾을 수 없습니다. URL을 확인해 주세요.";
  if (err.includes("Could not fetch URL (status 5"))
    return "서버 오류로 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.";
  if (err.includes("URL is not an HTML page"))
    return "이 URL은 HTML 페이지가 아닙니다 (예: PDF, 이미지). PDF로 가져오기를 사용해 주세요.";
  if (err.includes("No readable content found"))
    return "페이지에서 읽을 수 있는 내용을 찾지 못했습니다.";
  if (err.includes("Extraction too thin"))
    return "추출된 내용이 너무 짧습니다. 브라우저에서 직접 열어야 하는 페이지일 수 있습니다.";
  if (err.includes("No extractable text"))
    return "텍스트를 추출할 수 없습니다. 스캔된 이미지 PDF일 수 있습니다.";
  if (err.toLowerCase().includes("ollama did not respond"))
    return "Ollama가 응답하지 않습니다. 실행 중인지 확인해 주세요.";
  return err;
}
