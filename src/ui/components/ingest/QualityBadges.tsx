export interface QualityBadge {
  label: string;
  reason: string;
}

export function computeQualityBadges(markdown: string): QualityBadge[] {
  const badges: QualityBadge[] = [];

  const sectionCount = (markdown.match(/^##\s+/gm) ?? []).length;
  if (sectionCount <= 1) {
    badges.push({ label: "⚠ 내용 부족", reason: "섹션이 1개 이하입니다" });
  }

  const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(markdown);
  const hasSource = /^source(_file)?:/m.test(markdown);
  if (!hasFrontmatter || !hasSource) {
    badges.push({ label: "⚠ 출처 없음", reason: "source 필드가 없습니다" });
  }

  if (markdown.length < 500) {
    badges.push({ label: "⚠ 너무 짧음", reason: `${markdown.length}자 (500자 미만)` });
  }

  return badges;
}

interface QualityBadgesProps {
  badges: QualityBadge[];
}

export function QualityBadges({ badges }: QualityBadgesProps) {
  if (badges.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
      {badges.map((b) => (
        <span
          key={b.label}
          title={b.reason}
          style={{
            fontSize: "0.75rem",
            padding: "2px 7px",
            borderRadius: "10px",
            background: "var(--color-warning-bg, #3a2e00)",
            color: "var(--color-warning, #f0c040)",
            cursor: "default",
          }}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}
