import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  kicker: string;
  title: string;
  onClose: () => void;
  locked?: boolean;
  children: ReactNode;
}

export function Modal({ kicker, title, onClose, locked = false, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return <dialog ref={dialog} className="summary-dialog" aria-labelledby={titleId} onClose={onClose}
    onCancel={(event) => { if (locked) event.preventDefault(); }}
    onClick={(event) => { if (event.target === dialog.current && !locked) dialog.current.close(); }}>
    <div className="summary-dialog-body">
      <header>
        <span className="auth-kicker">{kicker}</span>
        <h2 id={titleId}>{title}</h2>
      </header>
      {children}
    </div>
  </dialog>;
}
