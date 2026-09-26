import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

type Theme = 'dark' | 'light';
type Density = 'compact' | 'comfortable';
interface Appearance {
  theme: Theme;
  density: Density;
  toggleTheme(): void;
  toggleDensity(): void;
}
const AppearanceContext = createContext<Appearance | null>(null);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Device appearance is available before authentication; it contains no identity or task data. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  // Preserve the existing explicit light/dark preference, defaulting new installations to W1 dark.
  const [theme, setTheme] = useState<Theme>(() =>
    stored('hexu-theme') === 'light' ? 'light' : 'dark',
  );
  const [density, setDensity] = useState<Density>(() =>
    stored('hexu-density') === 'comfortable' ? 'comfortable' : 'compact',
  );
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#0d1117' : '#f8fafc');
    try {
      localStorage.setItem('hexu-theme', theme);
      localStorage.setItem('hexu-density', density);
    } catch {
      // Appearance still works for this visit when browser storage is unavailable.
    }
  }, [theme, density]);
  return (
    <AppearanceContext.Provider
      value={{
        theme,
        density,
        toggleTheme: () => setTheme((value) => (value === 'dark' ? 'light' : 'dark')),
        toggleDensity: () =>
          setDensity((value) => (value === 'compact' ? 'comfortable' : 'compact')),
      }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('Missing appearance context');
  return value;
}
