"use client";

import type { CompareBlockDto, CompareCellDto, RevisionComparisonDto, RevisionHistoryItemDto } from "@iso-dms/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ApiError } from "@/lib/api/client";
import { getRevisionComparison, getRevisions } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";
import { cn } from "@/lib/utils";

const t = tr.compare;

const ADDED = "rounded-sm bg-emerald-100 px-0.5 text-emerald-900 no-underline";
const REMOVED = "rounded-sm bg-red-100 px-0.5 text-red-900 line-through";

function revisionLabel(revision: RevisionHistoryItemDto): string {
  const status = revision.isCurrent ? tr.revisions.status.CURRENT : tr.revisions.status[revision.status];
  return t.option(revision.revisionNo, status);
}

/** The two revisions to show: the ones in the address when they are valid, else the newest and the one before it. */
export function chooseRevisions(
  revisions: RevisionHistoryItemDto[],
  from: string | null,
  to: string | null,
): { from: string; to: string } | null {
  if (revisions.length < 2) return null;
  const ids = revisions.map((revision) => revision.id); // newest first
  const toId = to && ids.includes(to) ? to : ids[0];
  const fromId = from && ids.includes(from) && from !== toId ? from : (ids[ids.indexOf(toId) + 1] ?? ids.find((id) => id !== toId)!);
  return { from: fromId, to: toId };
}

function BlockView({ block }: { block: CompareBlockDto }) {
  const marker = block.kind === "equal" ? null : t.legend[block.kind];
  return (
    <li
      data-kind={block.kind}
      className={cn(
        "border-l-4 py-1 pl-3 text-sm leading-relaxed whitespace-pre-wrap",
        block.kind === "equal" && "border-transparent",
        block.kind === "added" && "border-emerald-500",
        block.kind === "removed" && "border-red-500",
        block.kind === "changed" && "border-amber-500",
      )}
    >
      {marker && <span className="sr-only">{marker}: </span>}
      {block.segments.map((segment, index) =>
        segment.type === "added" ? (
          <ins key={index} className={ADDED}>
            {segment.text}
          </ins>
        ) : segment.type === "removed" ? (
          <del key={index} className={REMOVED}>
            {segment.text}
          </del>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </li>
  );
}

function CellTable({ cells }: { cells: CompareCellDto[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-sm" aria-label={t.cellsLabel}>
        <thead className="border-b border-border bg-accent/60">
          <tr>
            {(["sheet", "cell", "change", "from", "to"] as const).map((column) => (
              <th key={column} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                {t.columns[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={`${cell.sheet}!${cell.address}`} data-kind={cell.kind} className="border-b border-border align-top last:border-0">
              <td className="px-4 py-2">{cell.sheet}</td>
              <td className="px-4 py-2 font-mono">{cell.address}</td>
              <td className="px-4 py-2 whitespace-nowrap">{t.legend[cell.kind]}</td>
              <td className="px-4 py-2 whitespace-pre-wrap">
                {cell.from === null ? <span className="text-muted">{t.empty}</span> : <del className={REMOVED}>{cell.from}</del>}
              </td>
              <td className="px-4 py-2 whitespace-pre-wrap">
                {cell.to === null ? <span className="text-muted">{t.empty}</span> : <ins className={ADDED}>{cell.to}</ins>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Result({ comparison }: { comparison: RevisionComparisonDto }) {
  const [onlyChanges, setOnlyChanges] = useState(false);
  const toggleId = useId();
  const { added, removed, changed } = comparison.summary;
  const unchanged = added + removed + changed === 0;
  const blocks = onlyChanges ? comparison.blocks.filter((block) => block.kind !== "equal") : comparison.blocks;

  return (
    <section aria-label={t.resultLabel} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 md:sticky md:top-0 md:z-10">
        <p className="text-sm font-medium" role="status">
          {unchanged ? t.noChanges : t.summary(added, removed, changed)}
        </p>
        {comparison.fileType === "DOCX" && (
          <label htmlFor={toggleId} className="flex items-center gap-2 text-sm">
            <input id={toggleId} type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />
            {t.onlyChanges}
          </label>
        )}
      </div>
      {comparison.fileType === "DOCX" ? (
        <Card className="p-4">
          <ul className="space-y-1">
            {blocks.map((block, index) => (
              <BlockView key={index} block={block} />
            ))}
          </ul>
        </Card>
      ) : (
        !unchanged && <CellTable cells={comparison.cells} />
      )}
    </section>
  );
}

/** Text difference between two revisions of a document (PROJECT.md 6.15). The choice lives in the address. */
export function RevisionCompare({ documentId }: { documentId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromId = useId();
  const toId = useId();

  const revisions = useQuery({ queryKey: ["revisions", documentId], queryFn: () => getRevisions(documentId), staleTime: 0 });
  const chosen = revisions.data ? chooseRevisions(revisions.data, searchParams.get("from"), searchParams.get("to")) : null;
  const comparison = useQuery({
    queryKey: ["revision-comparison", documentId, chosen?.from, chosen?.to],
    queryFn: () => getRevisionComparison(documentId, chosen!.from, chosen!.to),
    enabled: chosen !== null,
    // Every comparison is written to the audit trail: a refocused window must not ask again
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  function choose(patch: Partial<{ from: string; to: string }>) {
    if (!chosen) return;
    const next = { ...chosen, ...patch };
    router.replace(`${pathname}?from=${encodeURIComponent(next.from)}&to=${encodeURIComponent(next.to)}`, { scroll: false });
  }

  const back = (
    <Link
      href={`/documents/${documentId}`}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t.back}
    </Link>
  );

  if (revisions.isPending) {
    return (
      <p className="text-muted" role="status">
        {tr.common.loading}
      </p>
    );
  }
  if (revisions.isError) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{revisions.error instanceof ApiError ? errorMessage(revisions.error) : t.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => revisions.refetch()}>
          {tr.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {back}
      <div>
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <p className="mt-1 text-sm text-muted">{t.description}</p>
      </div>

      {chosen === null ? (
        <p className="text-muted">{t.needTwo}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={fromId}>{t.from}</Label>
              <Select id={fromId} value={chosen.from} onChange={(event) => choose({ from: event.target.value })}>
                {revisions.data.map((revision) => (
                  <option key={revision.id} value={revision.id} disabled={revision.id === chosen.to}>
                    {revisionLabel(revision)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={toId}>{t.to}</Label>
              <Select id={toId} value={chosen.to} onChange={(event) => choose({ to: event.target.value })}>
                {revisions.data.map((revision) => (
                  <option key={revision.id} value={revision.id} disabled={revision.id === chosen.from}>
                    {revisionLabel(revision)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {comparison.isPending && (
            <p className="text-muted" role="status">
              {t.comparing}
            </p>
          )}
          {comparison.isError && (
            <p role="alert" className="text-sm text-destructive">
              {comparison.error instanceof ApiError ? errorMessage(comparison.error) : tr.errors.NETWORK}
            </p>
          )}
          {comparison.isSuccess && <Result key={`${chosen.from}:${chosen.to}`} comparison={comparison.data} />}
        </>
      )}
    </div>
  );
}
