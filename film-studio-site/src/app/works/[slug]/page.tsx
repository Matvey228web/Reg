import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { projects, site } from "@/content/site";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return projects.map((project) => ({ slug: project.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  if (!project) return {};

  return {
    title: project.title,
    description: project.summary,
    openGraph: {
      title: `${project.title} — ${site.name}`,
      description: project.summary,
      images: [{ url: project.poster, width: 1600, height: 900, alt: project.title }],
    },
  };
}

export default async function ProjectPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const index = projects.findIndex((p) => p.slug === slug);
  const project = projects[index];
  if (!project) notFound();

  const next = projects[(index + 1) % projects.length];

  return (
    <article className="pt-16 sm:pt-20">
      <div className="relative aspect-[16/9] w-full overflow-hidden sm:aspect-[21/9]">
        <Image
          src={project.poster}
          alt={`Кадр из проекта «${project.title}»`}
          fill
          priority
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/50 to-transparent" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <header className="-mt-16 relative sm:-mt-24">
          <p className="eyebrow mb-4">
            {project.category} · {project.year}
          </p>
          <h1 className="display text-[clamp(2.25rem,6vw,4.5rem)]">{project.title}</h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">{project.summary}</p>
        </header>

        <dl className="mt-12 grid gap-6 border-y border-line/60 py-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-[0.18em] text-muted">Наша роль</dt>
            <dd className="mt-2">{project.role}</dd>
          </div>
          {project.client && (
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-muted">Клиент</dt>
              <dd className="mt-2">{project.client}</dd>
            </div>
          )}
          {project.duration && (
            <div>
              <dt className="text-xs uppercase tracking-[0.18em] text-muted">Хронометраж</dt>
              <dd className="mt-2">{project.duration}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs uppercase tracking-[0.18em] text-muted">Год</dt>
            <dd className="mt-2">{project.year}</dd>
          </div>
        </dl>

        <div className="mt-12 grid gap-12 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-5 text-lg leading-relaxed text-muted">
            {project.description.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>

          <div>
            <p className="eyebrow mb-4">Съёмочная группа</p>
            <ul className="space-y-3 text-sm">
              {project.credits.map((credit) => (
                <li
                  key={credit.role + credit.name}
                  className="flex justify-between gap-6 border-b border-line/60 pb-3"
                >
                  <span className="text-muted">{credit.role}</span>
                  <span>{credit.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {project.video && (
          <div className="mt-14 aspect-video w-full overflow-hidden rounded-lg border border-line bg-black">
            <iframe
              src={project.video}
              title={project.title}
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        )}

        <nav className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-line/60 py-10">
          <Link href="/#works" className="text-sm text-muted transition hover:text-fg">
            ← Все работы
          </Link>
          <Link href={`/works/${next.slug}/`} className="group text-right">
            <span className="block text-xs uppercase tracking-[0.18em] text-muted">
              Следующий проект
            </span>
            <span className="display mt-1 block text-2xl transition group-hover:text-accent">
              {next.title}
            </span>
          </Link>
        </nav>
      </div>
    </article>
  );
}
