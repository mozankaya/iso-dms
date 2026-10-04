import { EditorScreen } from "@/components/editor/editor-screen";

export default async function EditDocumentPage({ params }: PageProps<"/documents/[id]/edit">) {
  const { id } = await params;
  return <EditorScreen documentId={id} />;
}
