import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { registerInputDialog, unregisterInputDialog, type InputDialogRequest } from "../../api/dialog";

export function InputDialogHost() {
  const [request, setRequest] = useState<InputDialogRequest | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    registerInputDialog((req) => {
      previousFocusRef.current = document.activeElement;
      setValue(req.options.defaultValue ?? "");
      setRequest(req);
    });
    return () => unregisterInputDialog();
  }, []);

  useEffect(() => {
    if (request && inputRef.current) {
      inputRef.current.focus();
      if (request.options.defaultValue) {
        inputRef.current.select();
      }
    }
  }, [request]);

  const settle = useCallback((result: string | null) => {
    if (!request) return;
    request.resolve(result);
    setRequest(null);
    setValue("");
    if (previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
    }
  }, [request]);

  const handleSubmit = useCallback(() => {
    settle(value);
  }, [settle, value]);

  const handleCancel = useCallback(() => {
    settle(null);
  }, [settle]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  }, [handleSubmit, handleCancel]);

  if (!request) return null;

  return createPortal(
    <div className="modalOverlay" onClick={handleCancel} role="presentation">
      <div
        className="modalContent"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={request.options.title || "Input"}
      >
        <div className="modalHeader">
          <h3>{request.options.title || "Input"}</h3>
        </div>
        <div className="modalBody">
          <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>{request.message}</p>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={request.options.placeholder}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: "1px solid #e2e8f0" }}>
          <button className="smallButton" onClick={handleCancel}>Cancel</button>
          <button className="smallButton" onClick={handleSubmit} style={{ background: "#3b82f6", color: "#fff" }}>OK</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
