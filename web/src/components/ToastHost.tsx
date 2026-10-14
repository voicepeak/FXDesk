import { useStore } from '../store';
import type { Toast } from '../store';
import { cls } from '../util';

function icon(kind: Toast['kind']): string {
  if (kind === 'success') return '✓';
  if (kind === 'error') return '✕';
  return 'ℹ';
}

export default function ToastHost() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', `toast-${t.kind}`)} onClick={() => dismissToast(t.id)}>
          <span className="toast-icon">{icon(t.kind)}</span>
          <span className="toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
