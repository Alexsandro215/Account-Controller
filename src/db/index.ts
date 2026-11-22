import { prismaStore } from "./prismaStore.js";
import type { Store } from "./store.js";

let current: Store = prismaStore;

/** The store every module uses. Tests swap it with useStore(). */
export function db(): Store {
  return current;
}

export function useStore(store: Store): void {
  current = store;
}
