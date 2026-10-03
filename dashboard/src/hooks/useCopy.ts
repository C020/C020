import { useCallback } from 'react';
import { toast } from '../lib/toast';

export function useCopy(): (text: string, label?: string) => Promise<void> {
  return useCallback(async (text: string, label = 'تم النسخ') => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label, { duration: 1800 });
    } catch {
      toast.error('ما قدرنا ننسخ، انسخه يدوياً');
    }
  }, []);
}
