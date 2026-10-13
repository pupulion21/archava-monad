import { useEffect } from "react";
import { AlertCircle, X } from "lucide-react";
import { createPortal } from "react-dom";

export function FeedbackToast({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry?: () => void }) {
  useEffect(() => {
    if (!message || onRetry) return;
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss, onRetry]);

  if (!message) return null;
  return createPortal(
    <div className="site-feedback" role="alert" aria-atomic="true">
      <AlertCircle size={20} aria-hidden="true" />
      <div><p>{message}</p>{onRetry && <button type="button" onClick={onRetry}>Retry connection</button>}</div>
      <button type="button" className="site-feedback-dismiss" onClick={onDismiss} aria-label="Dismiss notification"><X size={19} /></button>
    </div>,
    document.body,
  );
}
