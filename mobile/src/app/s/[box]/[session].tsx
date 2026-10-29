import * as Haptics from "expo-haptics";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { agentLabel, sessionState } from "@berth/core/derive.ts";

import { whereOf } from "@/components/cards";
import { TranscriptRow } from "@/components/transcript";
import { Button, Chip, Empty, Note, Pill } from "@/components/ui";
import { can, phone } from "@/lib/api";
import { answerChoices } from "@/lib/choices";
import { convKey, useStore } from "@/lib/store";
import { mono, useColors } from "@/lib/theme";

// One session: its conversation (Chat) or its terminal's screen (Screen),
// the answers it offers when it waits, a few keys, and a prompt to send.

type View_ = "chat" | "screen";

export default function SessionScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ box: string; session: string }>();
  const id = decodeURIComponent(params.box);
  const name = decodeURIComponent(params.session);
  const box = useStore((s) => s.boxes.find((b) => b.id === id));
  const data = useStore((s) => s.data[id]);
  const conv = useStore((s) => s.conversations[convKey(id, name)]);
  const s = data?.sessions?.find((x) => x.name === name);
  const chatOK = can(data?.info, "transcript");
  const [view, setView] = useState<View_>("chat");
  const [screen, setScreen] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string>();
  const shown = !chatOK || conv?.source === "none" ? "screen" : view;
  const state = s ? sessionState(s) : undefined;
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);

  // Its notifications aren't shown while it's on screen.
  useFocusEffect(
    useCallback(() => {
      if (box) useStore.getState().setShowing(`${box.name}/${name}`);
      return () => useStore.getState().setShowing(undefined);
    }, [box, name]),
  );

  // The conversation: read now, then on every change the box reports (the
  // store reads it again on transcript.changed), and every 10 seconds in
  // case a change went unsaid.
  useEffect(() => {
    if (!chatOK) return;
    const read = () => void useStore.getState().readConversation(id, name);
    read();
    const t = setInterval(read, data?.live ? 10_000 : 4000);
    return () => clearInterval(t);
  }, [chatOK, id, name, data?.live]);

  // The screen: every two seconds while it shows, and while the agent
  // waits (its options are read from it).
  const waiting = state === "waiting" || state === "ready";
  useEffect(() => {
    if (!box || (shown !== "screen" && !(waiting && !s?.ask?.choices?.length))) return;
    let live = true;
    const read = () =>
      phone
        .screen(box, name, shown === "screen" ? 300 : 0)
        .then((r) => live && setScreen(r.screen.replace(/\n+$/, "")))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [box, name, shown, waiting, s?.ask?.choices?.length]);

  if (!box) return <Empty>This phone isn't paired with that box.</Empty>;
  const ended = data?.sessions && (!s || s.exited);
  const w = s ? whereOf(s) : { worktree: name, project: "" };
  const choices = answerChoices(s, screen);
  const isAgent = !!s?.agent;

  const act = async (what: () => Promise<unknown>, done?: string) => {
    try {
      await what();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setNote(done);
      if (done) setTimeout(() => setNote(undefined), 2000);
      void useStore.getState().refresh(id, { sessions: true });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setNote((err as Error).message);
    }
  };
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    await act(() => phone.send(box, name, t, true).then(() => setText("")), "Sent");
    setSending(false);
  };
  // A numbered option is its digit, typed without Enter; the box's send
  // gate sees it as an answer from the phone.
  const answer = (key: string) => act(() => phone.send(box, name, key, false), "Answered");
  const key = (k: string) => act(() => phone.key(box, name, k));
  const stop = () => act(() => (can(data?.info, "interrupt") ? phone.interrupt(box, name) : phone.key(box, name, "escape")), "Stopped");

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={90} style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: c.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
                {w.worktree}
              </Text>
              <Text style={{ color: c.muted, fontSize: 12 }} numberOfLines={1}>
                {[isAgent ? agentLabel(s!.agent!) : "Shell", w.project, box.name].filter(Boolean).join(" · ")}
              </Text>
            </View>
          ),
          headerRight: () => (state ? <Pill state={state} /> : null),
        }}
      />
      {ended ? (
        <View style={{ padding: 16 }}>
          <Empty>This session has ended.</Empty>
        </View>
      ) : (
        <>
          {chatOK && conv?.source !== "none" && (
            <View style={[st.segments, { borderColor: c.line }]}>
              {(["chat", "screen"] as const).map((v) => (
                <Pressable key={v} onPress={() => setView(v)} accessibilityRole="button" accessibilityState={{ selected: shown === v }} style={[st.segment, shown === v && { backgroundColor: c.accent }]}>
                  <Text style={{ color: shown === v ? c.accentFg : c.fg, fontWeight: "600", textAlign: "center" }}>{v === "chat" ? "Chat" : "Screen"}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {shown === "chat" ? (
            <FlatList
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 16, gap: 14 }}
              data={[...(conv?.items ?? [])].reverse()}
              inverted
              keyExtractor={(it) => it.id}
              renderItem={({ item }) => <TranscriptRow item={item} />}
              ListEmptyComponent={<Note>{conv?.error ?? (conv ? "Nothing said yet." : "Reading the conversation…")}</Note>}
            />
          ) : (
            <ScrollView ref={scroller} style={[st.screen, { backgroundColor: c.term }]} onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}>
              <Text selectable style={{ color: c.termFg, fontFamily: mono, fontSize: 11, lineHeight: 15 }}>
                {screen ?? "Loading…"}
              </Text>
            </ScrollView>
          )}
          <View style={[st.foot, { paddingBottom: Math.max(insets.bottom, 10), borderTopColor: c.line, backgroundColor: c.bg }]}>
            {choices.length > 0 && (
              <View style={{ gap: 6 }}>
                {choices.map((ch) => (
                  <Chip key={ch.key} k={ch.key} label={ch.label} onPress={() => void answer(ch.key)} />
                ))}
              </View>
            )}
            <View style={st.keys}>
              <Button title="Enter" tone="ghost" onPress={() => void key("enter")} style={st.key} />
              {shown === "screen" && <Button title="↑" tone="ghost" onPress={() => void key("up")} style={st.key} />}
              {shown === "screen" && <Button title="↓" tone="ghost" onPress={() => void key("down")} style={st.key} />}
              {shown === "screen" && <Button title="Tab" tone="ghost" onPress={() => void key("tab")} style={st.key} />}
              {isAgent ? <Button title="Stop" tone="danger" onPress={() => void stop()} style={st.key} /> : <Button title="Ctrl-C" tone="danger" onPress={() => void key("interrupt")} style={st.key} />}
            </View>
            <View style={st.compose}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={state === "running" ? "Send a prompt (it reads it next)" : "Send a prompt"}
                placeholderTextColor={c.muted}
                multiline
                style={[st.input, { color: c.fg, borderColor: c.line, backgroundColor: c.panel }]}
              />
              <Button title="Send" busy={sending} disabled={!text.trim()} onPress={() => void send()} />
            </View>
            {note && <Note bad={note !== "Sent" && note !== "Answered" && note !== "Stopped"}>{note}</Note>}
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  segments: { flexDirection: "row", borderWidth: 1, borderRadius: 12, padding: 3, gap: 3, marginHorizontal: 16, marginTop: 6, marginBottom: 4 },
  segment: { flex: 1, minHeight: 34, borderRadius: 9, justifyContent: "center" },
  screen: { flex: 1, margin: 12, marginBottom: 0, borderRadius: 12, padding: 10 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  keys: { flexDirection: "row", gap: 6 },
  key: { flex: 1, paddingHorizontal: 6, minHeight: 38 },
  compose: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 11, fontSize: 16 },
});
