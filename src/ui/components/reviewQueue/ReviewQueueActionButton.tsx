import type { CSSProperties, ReactNode } from "react";

export type ActionVariant = "approve" | "apply" | "reject" | "disabled";

const ACTION_VARIANT_STYLES: Record<ActionVariant, CSSProperties> = {
  approve: { background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7", cursor: "pointer" },
  apply: { background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd", cursor: "pointer" },
  reject: { background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5", cursor: "pointer" },
  disabled: { background: "#f1f5f9", color: "#94a3b8", border: "1px solid #e2e8f0", cursor: "not-allowed" },
};

export function ActionButton({
  variant,
  onClick,
  disabled,
  children,
}: {
  readonly variant: ActionVariant;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "3px 12px",
        fontSize: 12,
        borderRadius: 4,
        fontWeight: 600,
        ...ACTION_VARIANT_STYLES[variant],
      }}
    >
      {children}
    </button>
  );
}
