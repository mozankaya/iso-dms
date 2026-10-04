import { EditorScreen } from "@/components/editor/editor-screen";

export default async function EditDocumentPage({
  params,
  searchParams,
}: PageProps<"/documents/[id]/edit">) {
  const { id } = await params;
  const { revision } = await searchParams;
  return <EditorScreen documentId={id} requestedRevisionId={typeof revision === "string" ? revision : undefined} />;
}
