import { ArrowUpRightIcon, CircleCheckIcon, CircleXIcon, FlaskConicalIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { type RefObject, useContext, useEffect, useLayoutEffect, useState } from "react";

import { useFileWorktree } from "@/components/conversation/file-links";
import { isFile } from "@/lib/file-links";
import { parseRef } from "@/lib/file-refs";
import { openFile } from "@/lib/files";
import { PaneContext } from "@/lib/pane-context";
import { type TestFailure, type TestResult, parseTestResult } from "@/lib/test-results";
import { focusPane } from "@/lib/workspaces";
import "@/components/conversation/test-blocks.css";

// A recognized test transcript gets a result card inside its existing code
// frame. The original pre and Copy remain; Source shows every line exactly
// as the agent wrote it. Partial drafts and unknown outputs stay plain code.
interface Block {
  key: number;
  frame: HTMLElement;
  host: HTMLElement;
  slot: HTMLElement;
  label: HTMLElement;
  oldLabel: string;
  result: TestResult;
}

export function TestBlocks({ body, html, draft }: { body: RefObject<HTMLElement | null>; html: string; draft: boolean }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  useLayoutEffect(() => {
    const found: Block[] = [];
    if (!draft) body.current?.querySelectorAll<HTMLElement>(".cv-pre").forEach((frame, key) => {
      const code = frame.querySelector<HTMLElement>(":scope > pre > code");
      const copy = frame.querySelector<HTMLElement>(":scope > .cv-pre-head > [data-copy-code]");
      const label = frame.querySelector<HTMLElement>(":scope > .cv-pre-head > .cv-pre-lang");
      const result = code && parseTestResult(code.textContent ?? "");
      if (!result || !copy || !label) return;
      const host = document.createElement("div");
      host.className = "cv-test-host";
      const slot = document.createElement("span");
      slot.className = "cv-test-slot";
      frame.append(host);
      copy.before(slot);
      const oldLabel = label.textContent ?? "";
      label.textContent = `${result.runner} results`;
      frame.dataset.testResult = "";
      found.push({ key, frame, host, slot, label, oldLabel, result });
    });
    setBlocks((was) => (was.length || found.length ? found : was));
    return () => {
      for (const b of found) {
        b.host.remove();
        b.slot.remove();
        b.label.textContent = b.oldLabel;
        delete b.frame.dataset.testResult;
        delete b.frame.dataset.testSource;
      }
    };
  }, [body, html, draft]);
  return blocks.map((block) => <ResultBlock key={block.key} block={block} />);
}

function ResultBlock({ block }: { block: Block }) {
  const [source, setSource] = useState(false);
  useLayoutEffect(() => {
    if (source) block.frame.dataset.testSource = "";
    else delete block.frame.dataset.testSource;
  }, [block, source]);
  return (
    <>
      {createPortal(<button type="button" aria-label={source ? "Show test results" : "Show test output"} onClick={() => setSource((v) => !v)} className="cv-test-source">{source ? "Results" : "Source"}</button>, block.slot)}
      {createPortal(<ResultCard result={block.result} />, block.host)}
    </>
  );
}

function ResultCard({ result }: { result: TestResult }) {
  const failed = result.failed > 0;
  const Icon = failed ? CircleXIcon : CircleCheckIcon;
  return (
    <div data-testid="chat-test-results" data-runner={result.runner} className="cv-test-card" role="group" aria-label={`${result.runner}: ${result.failed} failed${result.passed !== undefined ? `, ${result.passed} passed` : ""}`}>
      <div className="cv-test-summary">
        <Icon className={failed ? "text-destructive-foreground" : "text-success-foreground"} size={17} aria-hidden />
        <strong>{failed ? `${result.failed} failed` : "All passed"}</strong>
        {result.passed !== undefined && <span className="text-muted-foreground">· {result.passed} passed</span>}
        <FlaskConicalIcon className="ml-auto text-muted-foreground/60" size={16} aria-hidden />
      </div>
      {result.failures.slice(0, 5).map((failure, i) => <FailureRow key={`${failure.name}-${i}`} failure={failure} />)}
      {result.failures.length > 5 && <p className="cv-test-more">And {result.failures.length - 5} more in Source</p>}
    </div>
  );
}

function FailureRow({ failure }: { failure: TestFailure }) {
  const worktree = useFileWorktree();
  const pane = useContext(PaneContext);
  const path = failure.file && parseRef(failure.file, worktree?.path)?.path;
  const [exists, setExists] = useState(false);
  useEffect(() => {
    setExists(false);
    if (!worktree || !path) return;
    let live = true;
    void isFile(worktree, path).then((yes) => live && setExists(yes));
    return () => { live = false; };
  }, [worktree, path]);
  const open = () => {
    if (!path) return;
    if (pane) focusPane(pane.wsKey, pane.tab, pane.pane);
    openFile(path, "tab", failure.line);
  };
  return (
    <div className="cv-test-failure">
      <span className="cv-test-failure-mark" aria-hidden>×</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{failure.name}</div>
        {failure.file && (exists && path ? (
          <button type="button" onClick={open} className="cv-test-file" aria-label={`Open ${path}${failure.line ? ` line ${failure.line}` : ""}`}>
            {failure.file}{failure.line ? `:${failure.line}` : ""}<ArrowUpRightIcon size={12} aria-hidden />
          </button>
        ) : <span className="font-mono text-tag text-muted-foreground">{failure.file}{failure.line ? `:${failure.line}` : ""}</span>)}
      </div>
    </div>
  );
}
