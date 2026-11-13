import { useEffect, useRef } from 'react';
import { Icon } from '../../components/Brand';

export interface MenuAction { label: string; onSelect: () => void; disabled?: boolean; hint?: string }

export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function close(event: Event) {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !details.contains(event.target as Node)) details.open = false;
    }
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, []);

  return <details ref={menu} className="document-menu folder-menu">
    <summary aria-label={label} title={label}><Icon name="more" size={18} /></summary>
    <div className="document-menu-body">
      {actions.map((action) => <button key={action.label} type="button" className="text-button menu-item" disabled={action.disabled} title={action.hint}
        onClick={() => { if (menu.current) menu.current.open = false; action.onSelect(); }}>{action.label}</button>)}
    </div>
  </details>;
}
