import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";

interface AvatarLauncherProps {
  label: string;
  hint: string;
  disabled: boolean;
  onOpen: () => void;
}

export function AvatarLauncher({ label, hint, disabled, onOpen }: AvatarLauncherProps) {
  return createPortal(
    <button type="button" className="avatar-launcher" disabled={disabled} onClick={onOpen} aria-describedby="avatar-launcher-hint">
      <span className="avatar-launcher-icon" aria-hidden="true"><MessageCircle size={22} /></span>
      <span className="avatar-launcher-copy"><strong>{label}</strong><span id="avatar-launcher-hint">{hint}</span></span>
    </button>,
    document.body,
  );
}
