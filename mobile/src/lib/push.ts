import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { can, phone } from "./api";
import { isDemo } from "./mock";
import { read, remove, write } from "./storage";
import type { Box, PhoneInfo } from "./types";

// Notifications: the phone's device token goes to the push relay, which
// seals it into a key; the key goes to each box, which sends it back to the
// relay with a notice when an agent needs you (push/README.md). Boxes never
// see the token, and the relay keeps nothing.

const INSTALL = "berth.install";
const KEY = "berth.push.key";
const ON = "berth.push.on";

const extra = (Constants.expoConfig?.extra ?? {}) as { relay?: string; apnsEnv?: "production" | "sandbox" };
const RELAY = extra.relay ?? "https://push.berthd.app";

// installId names this install to every box: 32 hex characters, made once.
export async function installId(): Promise<string> {
  let id = await read(INSTALL);
  if (!id) {
    id = Array.from(getRandomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
    await write(INSTALL, id);
  }
  return id;
}

// What the person asked to hear of: nothing (off), or waiting and maybe
// finished.
export type PushChoice = "off" | "waiting" | "waiting+finished";

export async function pushChoice(): Promise<PushChoice> {
  return ((await read(ON)) as PushChoice | null) ?? "off";
}

const states = (c: PushChoice) => (c === "waiting+finished" ? ["waiting", "finished"] : ["waiting"]);

// pushKey asks for permission, then for the relay's key for this phone's
// token, keeping it until the token changes.
export async function pushKey(): Promise<string> {
  if (Platform.OS !== "ios") throw new Error("Notifications from boxes come to iPhone first; Android is next.");
  if (!Device.isDevice) throw new Error("Notifications need a real iPhone, not the simulator.");
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) throw new Error("Notifications are off for Shipyard in Settings.");
  const { data: token } = await Notifications.getDevicePushTokenAsync();
  const held = JSON.parse((await read(KEY)) ?? "null") as { token: string; key: string } | null;
  if (held && held.token === token) return held.key;
  const res = await fetch(`${RELAY}/v1/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "ios", token, env: extra.apnsEnv ?? "sandbox", bundle: Constants.expoConfig?.ios?.bundleIdentifier ?? "dev.berth.phone" }),
  });
  const body = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !body.key) throw new Error(body.error ?? `The push relay answered ${res.status}`);
  await write(KEY, JSON.stringify({ token, key: body.key }));
  return body.key;
}

// registerBox asks one box to notify this phone, if it can; false when it
// can't (an older box, or the demo).
export async function registerBox(box: Box, info: PhoneInfo | undefined, key: string, choice: PushChoice): Promise<boolean> {
  if (isDemo(box) || !can(info, "push")) return false;
  await phone.register(box, { id: await installId(), name: (Device.deviceName ?? "iPhone").slice(0, 40), platform: "ios", key, on: states(choice) });
  return true;
}

export async function unregisterBox(box: Box, info: PhoneInfo | undefined): Promise<void> {
  if (isDemo(box) || !can(info, "push")) return;
  await phone.unregister(box, await installId());
}

// setPush turns notifications on (from every box that can) or off (on every
// box), and says which boxes couldn't.
export async function setPush(choice: PushChoice, boxes: { box: Box; info?: PhoneInfo }[]): Promise<{ failed: { box: Box; error: string }[] }> {
  const failed: { box: Box; error: string }[] = [];
  if (choice === "off") {
    await write(ON, "off");
    await Promise.all(boxes.map(({ box, info }) => unregisterBox(box, info).catch((err) => failed.push({ box, error: (err as Error).message }))));
    return { failed };
  }
  const key = await pushKey();
  await write(ON, choice);
  await Promise.all(boxes.map(({ box, info }) => registerBox(box, info, key, choice).catch((err) => failed.push({ box, error: (err as Error).message }))));
  return { failed };
}

// syncPush registers again with every box when notifications are on: at
// start, when the token changes, and after pairing.
export async function syncPush(boxes: { box: Box; info?: PhoneInfo }[]): Promise<void> {
  const choice = await pushChoice();
  if (choice === "off") return;
  await setPush(choice, boxes).catch(() => undefined);
}

export async function forgetPushKey(): Promise<void> {
  await remove(KEY);
}
