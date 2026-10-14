import React, { useEffect } from 'react';

export default function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width ?? 520 }}>
        <div className="modal-head">
          <div className="modal-title">{props.title}</div>
          <button className="icon-btn" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
