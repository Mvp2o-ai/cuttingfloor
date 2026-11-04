import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GUIDES, guide } from '../../../content/guides.ts';
import { GuideView, guideMetadata } from '../../guides/guide.tsx';

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.filter((g) => g.lang === 'es').map((g) => ({ slug: g.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const g = guide('es', (await params).slug);
  return g ? guideMetadata(g) : {};
}

export default async function GuiaPage({ params }: Props) {
  const g = guide('es', (await params).slug);
  if (!g) notFound();
  return <GuideView g={g} />;
}
