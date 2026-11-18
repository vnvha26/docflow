import { useEffect, useRef } from 'react';
import { Icon } from '../../components/Brand';
import { TYPE_FILTERS, typeFilterLabels } from '../../lib/documents';
import type { DocumentTypeFilter } from '../../lib/documents';

interface Props {
  value: DocumentTypeFilter | undefined;
  onChange: (next: DocumentTypeFilter | undefined) => void;
}

export function TypeFilterMenu({ value, onChange }: Props) {
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

  function choose(next: DocumentTypeFilter | undefined) {
    if (menu.current) menu.current.open = false;
    onChange(next);
  }

  const current = value ? typeFilterLabels[value] : 'Tất cả';
  return <details ref={menu} className="type-filter">
    <summary className={`type-filter-button${value ? ' is-active' : ''}`} aria-label={`Loại tài liệu: ${current}`}>
      <Icon name="file" size={15} /><span>Loại: <strong>{current}</strong></span><Icon name="chevron" size={15} />
    </summary>
    <div className="type-filter-body" role="menu" aria-label="Loại tài liệu">
      {[undefined, ...TYPE_FILTERS].map((type) => <button key={type ?? 'all'} type="button" role="menuitemradio"
        aria-checked={value === type} className="type-filter-option" onClick={() => choose(type)}>
        <span>{type ? typeFilterLabels[type] : 'Tất cả'}</span>
        {value === type && <Icon name="check" size={15} />}
      </button>)}
    </div>
  </details>;
}
