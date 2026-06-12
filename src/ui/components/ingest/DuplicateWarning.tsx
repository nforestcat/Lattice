interface DuplicateWarningProps {
  exactMatch: string;
  onOpenExisting: () => void;
  onContinue: () => void;
}

export function DuplicateWarning({ onOpenExisting, onContinue }: DuplicateWarningProps) {
  return (
    <div className="duplicate-warning">
      <p>⚠️ 이미 수집된 콘텐츠입니다.</p>
      <div className="duplicate-actions">
        <button onClick={onOpenExisting}>기존 노트 열기</button>
        <button onClick={onContinue}>계속 진행</button>
      </div>
    </div>
  );
}
