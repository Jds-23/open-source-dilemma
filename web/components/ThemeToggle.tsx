'use client';
import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };

/** Runs before paint (inlined in <head>) so a stored theme never flashes. */
export const THEME_BOOT = `try{var t=localStorage.getItem('osd-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    // Reading a value that only exists in the browser after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === 'light' || t === 'dark') setTheme(t);
  }, []);
  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    try {
      if (next === 'system') {
        delete document.documentElement.dataset.theme;
        localStorage.removeItem('osd-theme');
      } else {
        document.documentElement.dataset.theme = next;
        localStorage.setItem('osd-theme', next);
      }
    } catch {
      /* storage blocked: theme still applies for this page view */
    }
  }
  return (
    <button type="button" className="theme-toggle" onClick={cycle} aria-label={`Theme: ${theme}. Change theme`}>
      {theme === 'system' ? '◐ auto' : theme === 'dark' ? '● dark' : '○ light'}
    </button>
  );
}
