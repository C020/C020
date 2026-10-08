import { useCallback } from 'react';
import { toast } from '../lib/toast';
import { t } from '../i18n/core';

export function useCopy(): (text: string, label?: string) => Promise<void> {
  return useCallback(async (text: string, label?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label ?? t('common.copied'), { duration: 1800 });
    } catch {
      toast.error(t('common.copyFailed'));
    }
  }, []);
}
