import {
  BookOpen,
  ClipboardList,
  FileSignature,
  FileText,
  Folder,
  Globe,
  Handshake,
  ListChecks,
  Network,
  Workflow,
} from "lucide-react";

/** `Category.icon` holds one of these names; unknown or empty values fall back to a folder. */
export function CategoryIcon({ name, className }: { name: string | null; className?: string }) {
  const props = { className, "aria-hidden": true } as const;
  switch (name) {
    case "book-open":
      return <BookOpen {...props} />;
    case "clipboard-list":
      return <ClipboardList {...props} />;
    case "file-signature":
      return <FileSignature {...props} />;
    case "file-text":
      return <FileText {...props} />;
    case "globe":
      return <Globe {...props} />;
    case "handshake":
      return <Handshake {...props} />;
    case "list-checks":
      return <ListChecks {...props} />;
    case "network":
      return <Network {...props} />;
    case "workflow":
      return <Workflow {...props} />;
    default:
      return <Folder {...props} />;
  }
}
