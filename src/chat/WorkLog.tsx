// From t3code (MIT, T3 Tools Inc.): apps/web/src/components/chat/WorkLog.tsx.
import { createContext, use, type ComponentProps, type ReactNode } from "react";
import { FolderOpen, Pencil } from 'lucide-react';
import { useHost } from '../HostContext';
import type { ResourceActionHandler } from '../paneManagementApi';
import { useResourceActions } from './ResourceChip';
import { cn } from "./cn";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

/** Expanded members align with the header and use the same compact row geometry. */
export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        // A wrapped label keeps its icon beside the first line.
        wrapLabel ? "items-start" : "items-center",
      )}
    >
      {icon ? (
        <span className="relative flex size-6 shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <div
        className={cn(
          "min-w-0 flex-1 text-secondary-label",
          !wrapLabel && "truncate [&_*]:whitespace-nowrap",
        )}
      >
        {label}
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}

// No className/style escape hatch: consumers supply content and behavior, not geometry.
export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

/** Div-based disclosure supports selectable detail and nested actions in an entry. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

export function WorkLogDetails({
  children,
  kind = "text",
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";
}) {
  return (
    <div
      className={cn(
        "cursor-auto",
        kind === "text"
          ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
          : kind === "panel"
            ? "mt-0.5 mb-1.5"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** Kept outside the disclosure label so an action never toggles its patch. */
export function WorkLogResourceActions({ path, onAction }: { path: string; onAction?: ResourceActionHandler }) {
  const { local } = useHost();
  const { run, notice, busy } = useResourceActions(onAction);
  if (!local || !path.startsWith('/')) return null;
  const resource = { ref: path, path, kind: 'file' as const };
  return <span className="chat-work-resource-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button type="button" disabled={busy} title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void run(resource, 'reveal')}><FolderOpen className="size-3.5" /></button>
    <button type="button" disabled={busy} title="Open in editor" aria-label="Open in editor" onClick={() => void run(resource, 'editor')}><Pencil className="size-3.5" /></button>
    {notice ? <span role="status" className="text-xs text-destructive">{notice}</span> : null}
  </span>;
}
