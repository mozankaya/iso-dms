"use client";

import { DOCUMENT_SORT_FIELDS, type DocumentListItemDto, type DocumentSortField, type SortOrder } from "@iso-dms/shared";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { DocumentActionLink } from "@/components/documents/document-action-link";
import { StatusBadge } from "@/components/documents/status-badge";
import { formatDate } from "@/lib/format";
import { tr } from "@/lib/i18n/tr";

// Sorting and paging happen on the server (state lives in the URL), so no table features are needed:
// the table only provides the header and cell models.
const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, DocumentListItemDto>();

const columns = columnHelper.columns([
  columnHelper.accessor("code", {
    id: "code",
    header: tr.documents.columns.code,
    cell: (info) => <span className="font-mono text-sm">{info.getValue()}</span>,
  }),
  columnHelper.accessor("title", {
    id: "title",
    header: tr.documents.columns.title,
    cell: (info) => (
      <span className="flex flex-wrap items-center gap-2">
        {info.getValue()}
        {info.row.original.status !== "PUBLISHED" && <StatusBadge status={info.row.original.status} />}
      </span>
    ),
  }),
  columnHelper.accessor((row) => row.department.name, {
    id: "department",
    header: tr.documents.columns.department,
  }),
  columnHelper.accessor("firstPublishedAt", {
    id: "firstPublishedAt",
    header: tr.documents.columns.firstPublishedAt,
    cell: (info) => formatDate(info.getValue()),
  }),
  columnHelper.accessor("revisedAt", {
    id: "revisedAt",
    header: tr.documents.columns.revisedAt,
    cell: (info) => formatDate(info.getValue()),
  }),
  columnHelper.accessor("revisionNo", {
    id: "revisionNo",
    header: tr.documents.columns.revisionNo,
    cell: (info) => info.getValue() ?? "-",
  }),
  columnHelper.display({
    id: "actions",
    header: tr.documents.columns.actions,
    cell: (info) => <DocumentActionLink document={info.row.original} />,
  }),
]);

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

export function DocumentTable({
  data,
  sortBy,
  sortOrder,
  onSort,
}: {
  data: DocumentListItemDto[];
  sortBy: DocumentSortField;
  sortOrder: SortOrder;
  onSort: (field: DocumentSortField) => void;
}) {
  const table = useTable({ features, columns, data });

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-sm" aria-label={tr.documents.tableLabel}>
        <thead className="border-b border-border bg-accent/60">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const field = header.column.id as DocumentSortField;
                if (!DOCUMENT_SORT_FIELDS.includes(field)) {
                  return (
                    <th key={header.id} scope="col" className="px-4 py-3 font-medium whitespace-nowrap">
                      <table.FlexRender header={header} />
                    </th>
                  );
                }
                const active = field === sortBy;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={active ? ARIA_SORT[sortOrder] : "none"}
                    className="px-4 py-3 font-medium whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => onSort(field)}
                      className="inline-flex items-center gap-1.5 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <table.FlexRender header={header} />
                      {active ? (
                        sortOrder === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0 hover:bg-accent/40">
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3 align-top">
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
