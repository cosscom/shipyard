import { CommandBar, CommandLead, CommandTrail } from "@/components/command/command-bar";
import { HomeTabs } from "@/components/workspace/home-tabs";
import { TabStrip } from "@/components/workspace/tab-strip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useStore } from "@/lib/store";
import { homeBox, useWorkspaces } from "@/lib/workspaces";

// CommandHeader is the command layout's top line (Labs › Layout ›
// Command). In a worktree it is the tab strip, with where you are at its
// left and the agents at its right; on Home and the other views it is the
// same line without tabs, above the view's own header.
export function CommandHeader() {
  const workspace = useStore((s) => s.view.kind === "workspace");
  const onHome = useWorkspaces((s) => !s.current || !!homeBox(s.current));
  // A box's home terminals keep their own strip under the line.
  const homeTabs = useWorkspaces((s) => Object.keys(s.spaces).some((k) => homeBox(k) && s.spaces[k].tabs.length));
  // Narrow windows say less: the worktree without its project, counts
  // without words.
  const compact = useMediaQuery("(max-width: 1179px)");
  if (workspace && !onHome) return <TabStrip lead={<CommandLead compact={compact} divider />} trail={<CommandTrail compact={compact} />} noBreadcrumb />;
  return (
    <>
      <CommandBar compact={compact} />
      {workspace && homeTabs && <HomeTabs />}
    </>
  );
}
