import * as SecureStore from "expo-secure-store";

import { originOf, type PairedBox } from "@berth/core/pairing.ts";

import type { Box } from "./types";

// Everything the app keeps is in the keychain, readable after the phone's
// first unlock and never moved to another phone by a backup: the boxes'
// tokens above all.

const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const read = (key: string) => SecureStore.getItemAsync(key, opts);
export const write = (key: string, value: string) => SecureStore.setItemAsync(key, value, opts);
export const remove = (key: string) => SecureStore.deleteItemAsync(key, opts);

const BOXES = "berth.boxes";
const tokenKey = (id: string) => `berth.token.${id}`;

// boxId is a box's address as a key and a route segment.
export const boxId = (url: string) => (originOf(url) ?? url).replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]/g, "_");

export function toBox(p: PairedBox): Box {
  return { id: boxId(p.url), name: p.name, url: p.url, token: p.token };
}

// The list holds names and addresses; each token is kept on its own.
// A keychain that can't be read pairs nothing, rather than leaving the
// app on its splash screen.
export async function loadBoxes(): Promise<Box[]> {
  try {
    const list = JSON.parse((await read(BOXES)) ?? "[]") as { id: string; name: string; url: string }[];
    const out: Box[] = [];
    for (const b of Array.isArray(list) ? list : []) {
      const token = await read(tokenKey(b.id));
      if (token && b.url) out.push({ id: b.id, name: b.name, url: b.url, token });
    }
    return out;
  } catch {
    return [];
  }
}

export async function saveBoxes(boxes: Box[], dropped: Box[] = []): Promise<void> {
  for (const b of boxes) await write(tokenKey(b.id), b.token);
  for (const b of dropped) if (!boxes.some((x) => x.id === b.id)) await remove(tokenKey(b.id));
  await write(BOXES, JSON.stringify(boxes.map(({ id, name, url }) => ({ id, name, url }))));
}
