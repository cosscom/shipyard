import type { BerthPluginContext } from "@berth/plugin";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { PluginReactContext } from "@/plugins/context";
import { useRegistry } from "@/plugins/registry";
import { Tip } from "@/components/tip";

type Props = { plugin: string; children: ReactNode; inline?: boolean };
type State = { error?: Error };

// PluginBoundary renders a plugin's component under its own context and
// catches what it throws, so one broken plugin never blanks the app.
export function PluginBoundary({ plugin, children, inline }: Props) {
  const ctx = pluginContexts.get(plugin) ?? null;
  return (
    <PluginReactContext.Provider value={ctx}>
      <Catch plugin={plugin} inline={inline}>
        {children}
      </Catch>
    </PluginReactContext.Provider>
  );
}

// The context each loaded plugin was activated with, for its components.
export const pluginContexts = new Map<string, BerthPluginContext>();

class Catch extends Component<Omit<Props, "children"> & { children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`plugin ${this.props.plugin} failed to render`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const name = useRegistry.getState().plugins.find((p) => p.id === this.props.plugin)?.name ?? this.props.plugin;
    if (this.props.inline) {
      return (
        <Tip label={error.message}>
          <span className="text-destructive text-meta">{name} failed</span>
        </Tip>
      );
    }
    return (
      <div className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-body">
        <p className="font-medium">{name} hit an error</p>
        <pre className="mt-2 whitespace-pre-wrap text-muted-foreground text-meta">{error.message}</pre>
        <button type="button" className="mt-3 text-meta underline" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
