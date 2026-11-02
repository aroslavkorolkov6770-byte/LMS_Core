export interface InterfacePreferences {
  theme: "midnight" | "graphite" | "ocean" | "forest" | "ember" | "sand" | "porcelain" | "mist";
  density: "comfortable" | "compact";
  textSize: "normal" | "large";
  sidebarWidth: "standard" | "narrow";
  detailLevel: "essential" | "detailed";
  reducedMotion: boolean;
  maximizeOnStart: boolean;
  defaultView: "overview" | "services" | "browser" | "lms" | "database" | "repository" | "logs" | "settings";
  rememberLastView: boolean;
  autoFocusPreview: boolean;
  statusInterval: 5000 | 10000 | 30000;
  autoRefreshLogs: boolean;
  uiFont: "humanist" | "technical" | "system";
  contentWidth: "full" | "focused";
  borderContrast: "soft" | "strong";
  showServiceSummary: boolean;
  keyboardShortcuts: boolean;
  logWrap: boolean;
  logLineLimit: 300 | 1000 | 3000;
  logInterval: 2500 | 5000 | 10000;
}
export const defaults: Readonly<InterfacePreferences>;
export const themes: Record<InterfacePreferences["theme"], { label: string; light: boolean; background: string; text: string }>;
export function normalize(input: unknown): InterfacePreferences;
