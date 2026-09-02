import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Bookmark,
  BookOpen,
  Calculator,
  Camera,
  CircleDot,
  Clapperboard,
  Clock,
  FilePen,
  FileSearch,
  FileText,
  FolderGit,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  Keyboard,
  ListTodo,
  MousePointerClick,
  PackagePlus,
  Plug,
  ScanSearch,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  UnfoldVertical,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  shell: Terminal,
  terminal: Terminal,
  workspace_read: FileText,
  read_file: FileText,
  workspace_write: FilePen,
  write_file: FilePen,
  search_file: FileSearch,
  search_web: Globe,
  read_page: BookOpen,
  computer_open: AppWindow,
  browse: AppWindow,
  computer_click: MousePointerClick,
  click: MousePointerClick,
  computer_type: Keyboard,
  computer_key: Keyboard,
  type: Keyboard,
  computer_screenshot: Camera,
  screenshot: Camera,
  computer_scroll: UnfoldVertical,
  analyze_image: ScanSearch,
  analyze: ScanSearch,
  compose_cut: Clapperboard,
  export_cut: Clapperboard,
  compose: Clapperboard,
  approval: ShieldCheck,
  github_repos: FolderGit,
  github_tree: FolderGit,
  github_file: FileText,
  github_search: Search,
  github_issue: CircleDot,
  github_pr: GitPullRequest,
  github_commit: GitCommitHorizontal,
  catalog_search: Search,
  catalog_install: PackagePlus,
  now: Clock,
  calc: Calculator,
  convert: Calculator,
  wiki: BookOpen,
  remember: Bookmark,
  plan: ListTodo,
};

export function toolIcon(name: string): LucideIcon {
  if (name.startsWith("mcp_")) return Plug;
  if (name.startsWith("github_")) return MAP[name] ?? FolderGit;
  return MAP[name] ?? Square;
}

export function toolLabel(name: string): string {
  if (name.startsWith("mcp_")) return "mcp";
  return name.replaceAll("_", " ");
}
