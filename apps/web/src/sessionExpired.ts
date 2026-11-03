type Listener = () => void;

const listeners = new Set<Listener>();
let armed = false;

export function armSessionExpiry(on: boolean) {
  armed = on;
}

export function sessionExpiryArmed(): boolean {
  return armed;
}

export function onSessionExpired(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifySessionExpired() {
  if (!armed) return;
  for (const listener of listeners) listener();
}
