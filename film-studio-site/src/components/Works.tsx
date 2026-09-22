"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { projectCategories, projects, type ProjectCategory } from "@/content/site";
import Reveal from "./Reveal";
import Section from "./Section";

type Filter = ProjectCategory | "Все";

export default function Works() {
  const [filter, setFilter] = useState<Filter>("Все");

  const filters: Filter[] = useMemo(
    () => ["Все", ...projectCategories.filter((c) => projects.some((p) => p.category === c))],
    [],
  );

  const visible = useMemo(
    () => (filter === "Все" ? projects : projects.filter((p) => p.category === filter)),
    [filter],
  );

  return (
    <Section
      id="works"
      eyebrow="Работы"
      title="Избранные проекты"
      lead="Реклама, клипы, короткий метр и документальное — то, что мы сняли сами, от идеи до мастера."
    >
      <div className="mb-10 flex flex-wrap gap-2" role="tablist" aria-label="Фильтр проектов">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-4 py-2 text-sm transition ${
              filter === f
                ? "border-accent bg-accent text-black"
                : "border-line text-muted hover:border-accent hover:text-fg"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {visible.map((project, i) => (
          <Reveal key={project.slug} delay={(i % 2) * 90}>
            <Link
              href={`/works/${project.slug}/`}
              className="group block overflow-hidden rounded-lg border border-line bg-surface transition hover:border-accent/60"
            >
              <div className="relative aspect-video overflow-hidden">
                <Image
                  src={project.poster}
                  alt={`Кадр из проекта «${project.title}»`}
                  fill
                  sizes="(max-width: 640px) 100vw, 50vw"
                  className="object-cover transition duration-700 group-hover:scale-[1.04]"
                />
                <span className="absolute left-4 top-4 rounded-full bg-black/70 px-3 py-1 text-xs text-fg backdrop-blur">
                  {project.category}
                </span>
              </div>
              <div className="p-5 sm:p-6">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="display text-2xl transition group-hover:text-accent">
                    {project.title}
                  </h3>
                  <span className="text-sm text-muted">{project.year}</span>
                </div>
                <p className="mt-3 text-sm text-muted">{project.summary}</p>
                <p className="mt-4 text-xs uppercase tracking-[0.18em] text-muted">
                  {project.role}
                </p>
              </div>
            </Link>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
