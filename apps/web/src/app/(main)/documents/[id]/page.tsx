import { DocumentDetail } from "@/components/documents/document-detail";

export default async function DocumentPage({ params }: PageProps<"/documents/[id]">) {
  const { id } = await params;
  return <DocumentDetail documentId={id} />;
}
