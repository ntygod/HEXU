import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

type Theme = 'dark' | 'light';
type Density = 'compact' | 'comfortable';
interface Appearance {
  theme: Theme;
  density: Density;
  /** Coordinates make the reveal bloom from the toggle; without them it centers. */
  toggleTheme(at?: { x: number; y: number }): void;
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
        toggleTheme: (at) => {
          const next = theme === 'dark' ? 'light' : 'dark';
          const apply = () => setTheme(next);
          if (
            !document.startViewTransition ||
            matchMedia('(prefers-reduced-motion: reduce)').matches
          ) {
            apply();
            return;
          }
          const x = at?.x ?? innerWidth / 2;
          const y = at?.y ?? 0;
          const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
          const transition = document.startViewTransition(apply);
          transition.ready
            .then(() => {
              document.documentElement.animate(
                {
                  clipPath: [
                    `circle(0px at ${x}px ${y}px)`,
                    `circle(${radius}px at ${x}px ${y}px)`,
                  ],
                },
                {
                  duration: 420,
                  easing: 'cubic-bezier(0.2, 0, 0, 1)',
                  pseudoElement: '::view-transition-new(root)',
                },
              );
            })
            .catch(() => {});
        },
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
