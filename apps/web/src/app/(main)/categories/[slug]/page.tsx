import { CategoryView } from "./category-view";

export default async function CategoryPage({ params }: PageProps<"/categories/[slug]">) {
  const { slug } = await params;
  return <CategoryView slug={slug} />;
}
