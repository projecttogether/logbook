"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * The theme a page shows: "dark" while <html> has the class `dark` (which the
 * app's theme switch sets), else "light". Follows changes.
 */
export function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, snapshot, () => "light");
}

function snapshot(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** What a person chose under "Appearance": light, dark, or as the device is set. */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

const THEME_KEY = "logbook.theme";
const THEME_EVENT = "logbook:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The choice when the browser refuses storage (some private windows): it lasts for this page. */
let unsavedTheme: ThemePreference = "system";

function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return unsavedTheme;
  }
}

function subscribeThemePreference(onChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Sets the class `dark` on <html> for a preference; "system" follows the device. */
export function applyThemePreference(preference: ThemePreference): void {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * The person's appearance, saved in this browser, with the class `dark` on
 * <html> kept in step (also when the device switches while "system" is
 * chosen). For apps without a theme store of their own; an app that saves
 * the choice with the person passes its own value to the frame instead.
 */
export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const preference = useSyncExternalStore<ThemePreference>(
    subscribeThemePreference,
    readThemePreference,
    () => "system",
  );

  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;
    const media = window.matchMedia(DARK_QUERY);
    const follow = () => applyThemePreference("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, next);
    } catch {
      unsavedTheme = next;
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  return [preference, setPreference];
}
