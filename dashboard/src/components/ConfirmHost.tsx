import { TriangleAlert, CircleHelp } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { confirmStore, settleConfirm } from '../lib/confirm';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';

/** Renders the app-wide confirm dialog opened via confirmDialog(). */
export function ConfirmHost() {
  const pending = useSyncExternalStore(confirmStore.subscribe, confirmStore.get);
  if (!pending) return null;
  return <ConfirmDialogView key={pending.id} {...pending} />;
}

function ConfirmDialogView({
  title,
  description,
  confirmLabel = 'تأكيد',
  cancelLabel = 'إلغاء',
  tone = 'default',
  requireText,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  requireText?: string;
}) {
  const [typed, setTyped] = useState('');
  const blocked = !!requireText && typed.trim() !== requireText.trim();
  return (
    <Modal
      open
      size="sm"
      onClose={() => settleConfirm(false)}
      title={title}
      icon={tone === 'danger' ? <TriangleAlert className="size-5 text-rose-300" /> : <CircleHelp className="size-5" />}
      footer={
        <>
          <Button variant="ghost" onClick={() => settleConfirm(false)}>
            {cancelLabel}
          </Button>
          <Button data-autofocus={requireText ? undefined : true} variant={tone === 'danger' ? 'danger' : 'primary'} disabled={blocked} onClick={() => settleConfirm(true)}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p className="text-sm leading-relaxed text-zinc-300">{description}</p>}
      {requireText && (
        <div className="mt-4 space-y-2">
          <p className="text-[13px] text-zinc-400">
            للتأكيد اكتب <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-medium text-zinc-200">{requireText}</span>
          </p>
          <Input
            data-autofocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !blocked) settleConfirm(true);
            }}
          />
        </div>
      )}
    </Modal>
  );
}
