import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { BoxStatus, Location } from "@/lib/api";
import { projectKey } from "@/lib/projects";
import { plainError } from "@/lib/errors";
import { NONE, useStore } from "@/lib/store";

// A project is one repository across boxes: "shop" on devl, build and homelab is
// one project with three members. Members are found by the repository's
// owner/name (its remote), or by the location's name when it has no remote.
// The person can rename a project, merge and split them, pick its default
// box and put it in a section; those choices are all that is stored (on the
// laptop agent, /v1/app/projects). Everything else comes from the boxes.

export interface MemberRef {
  box: string;
  location: string;
}

export interface ProjectOverride {
  id: string;
  name?: string;
  slug?: string;
  // An older name for section; read, never written.
  group?: string;
  // Members claimed by hand (a merge or a split); they leave their own group.
  members?: MemberRef[];
  default_box?: string;
  section?: string;
}

export interface ProjectsDoc {
  projects: ProjectOverride[];
  sections: string[];
  // Whatever else is stored there is kept as it is.
  [extra: string]: unknown;
}

export interface Member {
  box: BoxStatus;
  loc: Location;
}

export interface Project {
  id: string;
  name: string;
  slug?: string;
  remote?: string;
  members: Member[];
  // The box new work goes to unless another is chosen.
  defaultBox: string;
  section?: string;
}

const EMPTY: ProjectsDoc = { projects: [], sections: [] };

interface State {
  doc: ProjectsDoc;
  loaded: boolean;
  error?: string;
}

export const useProjectsDoc = create<State>()(() => ({ doc: EMPTY, loaded: false }));

export async function loadProjects() {
  const client = useStore.getState().client;
  if (!client) return;
  try {
    const doc = await client.laptop<ProjectsDoc | null>("GET", "/v1/app/projects");
    useProjectsDoc.setState({ doc: normalize(doc), loaded: true, error: undefined });
  } catch (err) {
    useProjectsDoc.setState({ loaded: true, error: plainError(err) });
  }
}

function normalize(doc: Partial<ProjectsDoc> | null): ProjectsDoc {
  const sections = [...(doc?.sections ?? [])];
  const projects = (doc?.projects ?? []).map((p) => {
    const section = p.section ?? p.group;
    if (section && !sections.includes(section)) sections.push(section);
    return { ...p, section };
  });
  return { ...doc, projects, sections };
}

// saveProjects changes the stored choices: it re-reads the document first,
// so changes made elsewhere (another window, the New worktree dialog) are
// kept, then writes it back whole.
async function saveProjects(fn: (doc: ProjectsDoc) => ProjectsDoc) {
  const before = useProjectsDoc.getState().doc;
  const client = useStore.getState().client;
  let base = before;
  if (client) {
    try {
      base = normalize(await client.laptop<ProjectsDoc | null>("GET", "/v1/app/projects"));
    } catch {
      // Write what this window has.
    }
  }
  const next = fn(structuredClone(base));
  useProjectsDoc.setState({ doc: next });
  if (!client) return;
  try {
    await client.laptop("PUT", "/v1/app/projects", next);
  } catch (err) {
    useProjectsDoc.setState({ doc: before, error: plainError(err) });
    throw err;
  }
}

// A project's id is projectKey's, the same the New worktree dialog uses.
const autoId = (loc: Location) => projectKey(loc);
const memberKey = (m: MemberRef) => `${m.box}/${m.location}`;

// deriveProjects groups every location on every box into projects.
export function deriveProjects(boxes: BoxStatus[], data: Record<string, { locations?: Location[] } | undefined>, doc: ProjectsDoc): Project[] {
  const all = new Map<string, Member>();
  for (const b of boxes) for (const loc of data[b.name]?.locations ?? []) all.set(memberKey({ box: b.name, location: loc.name }), { box: b, loc });

  const groups = new Map<string, Member[]>();
  const claimed = new Set<string>();
  for (const o of doc.projects) {
    if (!o.members?.length) continue;
    const ms = o.members.map((m) => all.get(memberKey(m))).filter((m): m is Member => !!m && !claimed.has(memberKey({ box: m.box.name, location: m.loc.name })));
    ms.forEach((m) => claimed.add(memberKey({ box: m.box.name, location: m.loc.name })));
    if (ms.length) groups.set(o.id, ms);
  }
  for (const [key, m] of all) {
    if (claimed.has(key)) continue;
    const id = autoId(m.loc);
    groups.set(id, [...(groups.get(id) ?? []), m]);
  }

  const out: Project[] = [];
  for (const [id, members] of groups) {
    const o = doc.projects.find((p) => p.id === id);
    members.sort((a, b) => Number(b.box.state === "online") - Number(a.box.state === "online") || a.box.name.localeCompare(b.box.name));
    const slug = o?.slug ?? members.find((m) => m.loc.slug)?.loc.slug;
    const names = members.map((m) => m.loc.name);
    const common = names.sort((a, b) => names.filter((n) => n === b).length - names.filter((n) => n === a).length)[0];
    const defaultBox = o?.default_box && members.some((m) => m.box.name === o.default_box) ? o.default_box : (members.find((m) => m.box.state === "online") ?? members[0]).box.name;
    out.push({
      id,
      name: o?.name ?? common,
      slug,
      remote: members.find((m) => m.loc.remote)?.loc.remote,
      members,
      defaultBox,
      section: o?.section && doc.sections.includes(o.section) ? o.section : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// useProjects is every project, live.
export function useProjects(): { projects: Project[]; sections: string[] } {
  const boxes = useStore((s) => s.status?.boxes ?? NONE);
  // Only the boxes' locations: an agent's state changing (every few
  // seconds on a busy box) leaves the projects, and the sidebar's rows drawn
  // from them, as they are.
  const locations = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.boxes).map(([name, d]) => [name, d.locations]))));
  const doc = useProjectsDoc((s) => s.doc);
  return useMemo(() => {
    const data = Object.fromEntries(Object.entries(locations).map(([name, l]) => [name, { locations: l }]));
    return { projects: deriveProjects(boxes, data, doc), sections: doc.sections };
  }, [boxes, locations, doc]);
}

export function projectOf(box: string, location: string): Project | undefined {
  const st = useStore.getState();
  return deriveProjects(st.status?.boxes ?? [], st.boxes, useProjectsDoc.getState().doc).find((p) => p.members.some((m) => m.box.name === box && m.loc.name === location));
}

function upsert(doc: ProjectsDoc, id: string, patch: Partial<ProjectOverride>): ProjectsDoc {
  const i = doc.projects.findIndex((p) => p.id === id);
  if (i < 0) doc.projects.push({ id, ...patch });
  else doc.projects[i] = { ...doc.projects[i], ...patch };
  return doc;
}

const refs = (p: Project): MemberRef[] => p.members.map((m) => ({ box: m.box.name, location: m.loc.name }));

export const projectActions = {
  rename: (p: Project, name: string) => saveProjects((d) => upsert(d, p.id, { name: name.trim() || undefined })),
  setDefaultBox: (p: Project, box: string) => saveProjects((d) => upsert(d, p.id, { default_box: box })),
  setSection: (p: Project, section?: string) => saveProjects((d) => upsert(d, p.id, { section })),
  addSection: (name: string, p?: Project) =>
    saveProjects((d) => {
      const n = name.trim();
      if (n && !d.sections.includes(n)) d.sections.push(n);
      return p ? upsert(d, p.id, { section: n }) : d;
    }),
  renameSection: (from: string, to: string) =>
    saveProjects((d) => {
      const n = to.trim();
      if (!n || d.sections.includes(n)) return d;
      d.sections = d.sections.map((s) => (s === from ? n : s));
      d.projects.forEach((p) => p.section === from && (p.section = n));
      return d;
    }),
  removeSection: (name: string) =>
    saveProjects((d) => {
      d.sections = d.sections.filter((s) => s !== name);
      d.projects.forEach((p) => p.section === name && (p.section = undefined));
      return d;
    }),
  // merge puts from's boxes into into: one project from then on.
  merge: (into: Project, from: Project) =>
    saveProjects((d) => {
      d.projects = d.projects.filter((p) => p.id !== from.id);
      return upsert(d, into.id, { members: [...refs(into), ...refs(from)], slug: into.slug, name: into.name });
    }),
  // split takes one box's copy out into a project of its own.
  split: (p: Project, box: string) =>
    saveProjects((d) => {
      const leaving = refs(p).filter((m) => m.box === box);
      const staying = refs(p).filter((m) => m.box !== box);
      upsert(d, p.id, { members: staying });
      d.projects.push({ id: `split:${p.id}:${box}`, name: `${p.name} (${box})`, members: leaving, section: p.section });
      return d;
    }),
};
