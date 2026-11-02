export type PreventedUnloadEvent = { preventDefault: () => void };

// Electron keeps the page open by default. Only the explicit second choice may discard its draft.
export function confirmPreventedUnload(event: PreventedUnloadEvent, ask: () => number): boolean {
  try {
    if (ask() !== 1) return false;
    event.preventDefault();
    return true;
  } catch {
    // An unavailable dialog must not silently approve leaving an unsaved document.
    return false;
  }
}
