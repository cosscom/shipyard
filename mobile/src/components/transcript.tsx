import { StyleSheet, Text, View } from "react-native";

import { toolSummary, type TranscriptItem } from "@berth/core/transcript.ts";

import { mono, useColors, type Colors } from "@/lib/theme";

// One item of an agent's conversation, as the phone shows it: the person's
// prompts on the right, the agent's words, its tool calls and edits in a
// line each, its questions with their answers, and notices.

export function TranscriptRow({ item }: { item: TranscriptItem }) {
  const c = useColors();
  switch (item.kind) {
    case "user":
      return (
        <View style={[st.user, { backgroundColor: c.sunk }]}>
          <Text style={{ color: c.fg, fontSize: 15, lineHeight: 21 }}>{item.text}</Text>
        </View>
      );
    case "text":
      return <Prose text={item.text} c={c} />;
    case "tools":
      return <Meta c={c} text={`${item.done ? "" : "… "}${toolSummary(item)}`} lines={(item.items ?? []).slice(-3).map((t) => `${t.verb} ${t.target}`)} />;
    case "edit":
      return (
        <Meta
          c={c}
          text={`Edited ${item.file}`}
          right={
            <Text style={{ fontFamily: mono, fontSize: 12 }}>
              <Text style={{ color: c.done }}>+{item.added}</Text> <Text style={{ color: c.bad }}>−{item.removed}</Text>
            </Text>
          }
        />
      );
    case "crew":
      return <Meta c={c} text={`Helpers: ${item.names.join(", ")}`} />;
    case "command":
      return (
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.muted, fontFamily: mono, fontSize: 13 }}>
            {item.command}
            {item.args ? ` ${item.args}` : ""}
          </Text>
          {!!item.text && <Code text={item.text} c={c} />}
        </View>
      );
    case "notice":
      return (
        <View style={[st.notice, { borderColor: item.level === "error" ? c.bad : c.line }]}>
          <Text style={{ color: item.level === "error" ? c.bad : c.fg, fontSize: 14 }}>{item.text}</Text>
        </View>
      );
    case "question":
      return (
        <View style={[st.notice, { borderColor: item.done ? c.line : c.waiting, gap: 8 }]}>
          {item.questions.map((q, i) => (
            <View key={i} style={{ gap: 4 }}>
              <Text style={{ color: c.fg, fontSize: 15, fontWeight: "600" }}>{q.header || q.question.split("\n")[0]}</Text>
              {!item.done && q.options.map((o) => <Text key={o.label} style={{ color: c.muted, fontSize: 14 }}>{`• ${o.label}`}</Text>)}
              {item.done && !!item.answers?.[i] && <Text style={{ color: c.done, fontSize: 14 }}>{item.answers[i]}</Text>}
            </View>
          ))}
          {!item.done && <Text style={{ color: c.muted, fontSize: 13 }}>Answer it on the Screen tab, or in Shipyard on your laptop.</Text>}
        </View>
      );
    case "report":
      return <Meta c={c} text={item.report.summary || `${item.report.title ?? item.report.kind}: ${item.report.status}`} />;
    case "agent-message":
    case "ping":
      return (
        <View style={[st.notice, { borderColor: c.line, gap: 4 }]}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{item.msg.from.name}</Text>
          <Text style={{ color: c.fg, fontSize: 14 }}>{item.msg.body || item.msg.summary || item.msg.title || item.msg.status}</Text>
        </View>
      );
    default:
      return null;
  }
}

function Meta({ text, lines, right, c }: { text: string; lines?: string[]; right?: React.ReactNode; c: Colors }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ color: c.muted, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
          {text}
        </Text>
        {right}
      </View>
      {lines?.map((l, i) => (
        <Text key={i} style={{ color: c.muted, fontSize: 12, fontFamily: mono }} numberOfLines={1}>
          {l}
        </Text>
      ))}
    </View>
  );
}

function Code({ text, c }: { text: string; c: Colors }) {
  return (
    <View style={[st.code, { backgroundColor: c.term }]}>
      <Text style={{ color: c.termFg, fontFamily: mono, fontSize: 12, lineHeight: 17 }}>{text.replace(/\n+$/, "")}</Text>
    </View>
  );
}

// Prose is an agent's words: paragraphs, with fenced code shown as code.
// Markdown's other marks stay as written, which reads well enough.
export function Prose({ text, c }: { text: string; c: Colors }) {
  const parts = text.split(/^```[^\n]*\n?/m);
  return (
    <View style={{ gap: 8 }}>
      {parts.map((p, i) =>
        i % 2 ? (
          <Code key={i} text={p} c={c} />
        ) : p.trim() ? (
          <Text key={i} style={{ color: c.fg, fontSize: 15, lineHeight: 22 }} selectable>
            {p.trim()}
          </Text>
        ) : null,
      )}
    </View>
  );
}

const st = StyleSheet.create({
  user: { alignSelf: "flex-end", maxWidth: "88%", borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 10 },
  code: { borderRadius: 8, padding: 10 },
});
