/** Tiny self-contained Arabic HTML pages (no scripts, inline styles only) for non-SPA responses. */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface PageOptions {
  title: string;
  /** Paragraphs (plain text, escaped). */
  lines: string[];
  /** Optional preformatted command shown in a code block. */
  code?: string;
  action?: { href: string; label: string };
}

export function renderPage(options: PageOptions): string {
  const lines = options.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n      ');
  const code = options.code ? `<pre dir="ltr">${escapeHtml(options.code)}</pre>` : '';
  const action = options.action ? `<a class="btn" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>` : '';
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e6e8ee;
        font-family: "Segoe UI", Tahoma, "Noto Sans Arabic", system-ui, sans-serif; }
      main { max-width: 34rem; margin: 1.5rem; padding: 2rem; border-radius: 16px; background: #181b22; border: 1px solid #262a33; }
      h1 { margin: 0 0 1rem; font-size: 1.35rem; }
      p { line-height: 1.8; color: #b8bdc9; margin: 0.5rem 0; }
      pre { background: #0b0d11; border: 1px solid #262a33; border-radius: 10px; padding: 0.75rem 1rem; overflow-x: auto; color: #9fe6a0; }
      .btn { display: inline-block; margin-top: 1.25rem; padding: 0.6rem 1.2rem; border-radius: 10px; background: #5865f2; color: #fff; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(options.title)}</h1>
      ${lines}
      ${code}
      ${action}
    </main>
  </body>
</html>
`;
}

export function buildMissingPage(): string {
  return renderPage({
    title: 'لوحة التحكم مو مبنية للحين',
    lines: [
      'البوت شغّال، بس ملفات لوحة التحكم (الواجهة) ما انبنت.',
      'شغّل الأمر هذا في مجلد المشروع وبعدها حدّث الصفحة:',
    ],
    code: 'npm run build',
  });
}

export function authErrorPage(message: string): string {
  return renderPage({
    title: 'ما قدرنا نسجّل دخولك',
    lines: [message],
    action: { href: '/auth/login', label: 'حاول مرة ثانية' },
  });
}
