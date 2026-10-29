import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { parsePairing } from "@berth/core/pairing.ts";

import { Button, Label, Note } from "@/components/ui";
import { phone } from "@/lib/api";
import { syncPush } from "@/lib/push";
import { useStore } from "@/lib/store";
import { useColors } from "@/lib/theme";
import type { Box } from "@/lib/types";

// Pairing: scan the code Shipyard shows in Settings → Phone (the same one
// the web phone app opens), or paste its link. Each box is asked who it is
// before it's kept, so a link that can't reach anything says so.

export default function Pair() {
  const c = useColors();
  const [perm, ask] = useCameraPermissions();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scanned = useRef(false);

  const pair = async (link: string) => {
    const list = parsePairing(link);
    if (!list) {
      setError(/#pair=/.test(link) ? "That pairing link is damaged. Show the code again in Shipyard." : "That isn't a pairing code from Shipyard → Settings → Phone.");
      scanned.current = false;
      return;
    }
    setBusy(true);
    setError(undefined);
    const checks = await Promise.all(
      list.map(async (b) => {
        try {
          const info = await phone.info({ id: "", ...b } as Box);
          return { b: { ...b, name: info.box || b.name }, error: undefined };
        } catch (err) {
          return { b, error: (err as Error).message };
        }
      }),
    );
    const ok = checks.filter((x) => !x.error).map((x) => x.b);
    if (!ok.length) {
      setBusy(false);
      setError(`${checks[0].error} The phone needs Tailscale on, signed in to your boxes' tailnet.`);
      scanned.current = false;
      return;
    }
    await useStore.getState().pair(ok);
    // The new boxes notify this phone too, when notifications are on.
    setTimeout(() => {
      const { boxes, data } = useStore.getState();
      void syncPush(boxes.map((box) => ({ box, info: data[box.id]?.info })));
    }, 2000);
    setBusy(false);
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={st.page} keyboardShouldPersistTaps="handled">
        <Label size={22} weight="700">
          Pair this phone
        </Label>
        <Note>On your laptop, open Shipyard → Settings → Phone, turn on phone access for your boxes, and scan the code here.</Note>
        <View style={[st.camera, { backgroundColor: c.term }]}>
          {perm?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                if (scanned.current || busy) return;
                scanned.current = true;
                void pair(data);
              }}
            />
          ) : (
            <View style={st.ask}>
              <Note>{perm && !perm.canAskAgain ? "Camera access is off for Shipyard in Settings. Paste the link instead." : "Shipyard uses the camera only to read the pairing code."}</Note>
              {(!perm || perm.canAskAgain) && <Button title="Scan the code" onPress={() => void ask()} />}
            </View>
          )}
        </View>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Or paste a pairing link"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[st.input, { color: c.fg, borderColor: c.line, backgroundColor: c.panel }]}
        />
        <View style={st.row}>
          <Button title="Paste" tone="ghost" onPress={() => void Clipboard.getStringAsync().then(setText)} style={{ flex: 1 }} />
          <Button title="Pair" busy={busy} disabled={!text.trim()} onPress={() => void pair(text)} style={{ flex: 1 }} />
        </View>
        {error && <Note bad>{error}</Note>}
        <Note>This phone needs Tailscale, signed in to the tailnet your boxes are on.</Note>
        <Button
          title="Try the demo"
          tone="ghost"
          onPress={() => {
            useStore.getState().startDemo();
            router.replace("/");
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  camera: { height: 280, borderRadius: 16, overflow: "hidden" },
  ask: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 20 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
  row: { flexDirection: "row", gap: 10 },
});
