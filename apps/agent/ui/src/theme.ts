import { useEffect } from "react";

/**
 * Follows the OS light/dark preference and applies it by setting the same
 * attributes the web app's two theme layers already key off of (see
 * packages/ui/src/theme.css): `data-nx-theme` on <html> (Precision Dark,
 * dark only) and `data-app-theme` + `data-om-theme` on <body> (the
 * Indigo/Slate app-shell palette, which is dark by default and light when
 * `data-om-theme="light"`). No new palette is introduced -- dark mode here
 * is exactly Precision Dark, light mode is exactly the existing app-shell
 * light theme.
 */
export function useOsTheme(): void {
  useEffect(() => {
    const apply = (dark: boolean) => {
      document.documentElement.setAttribute("data-nx-theme", dark ? "dark" : "light");
      document.body.setAttribute("data-app-theme", "");
      document.body.setAttribute("data-om-theme", dark ? "dark" : "light");
    };

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    apply(mql.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
}
