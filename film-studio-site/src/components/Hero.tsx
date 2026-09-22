"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { site, stats } from "@/content/site";
import VideoModal from "./VideoModal";

export default function Hero() {
  const [showreelOpen, setShowreelOpen] = useState(false);

  return (
    <section className="grain relative isolate flex min-h-[92svh] items-end overflow-hidden pt-24">
      <div className="absolute inset-0 -z-10">
        {site.heroVideo ? (
          <video
            className="h-full w-full object-cover"
            src={site.heroVideo}
            poster={site.heroPoster}
            autoPlay
            muted
            loop
            playsInline
          />
        ) : (
          <Image
            src={site.heroPoster}
            alt=""
            fill
            priority
            className="object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/30" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-24">
        <p className="eyebrow mb-6">
          {site.tagline} · {site.city}
        </p>
        <h1 className="display max-w-4xl text-[clamp(2.5rem,7vw,5.5rem)]">
          {site.heroTitle.split("\n").map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted">{site.heroSubtitle}</p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          {site.showreelUrl && (
            <button
              type="button"
              onClick={() => setShowreelOpen(true)}
              className="group inline-flex items-center gap-3 rounded-full bg-accent px-6 py-3 text-sm font-medium text-black transition hover:bg-accent/85"
            >
              <span
                aria-hidden
                className="inline-block h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-black"
              />
              Смотреть шоурил
            </button>
          )}
          <Link
            href="/#contact"
            className="inline-flex rounded-full border border-line px-6 py-3 text-sm transition hover:border-accent hover:text-accent"
          >
            Обсудить проект
          </Link>
        </div>

        <dl className="mt-16 grid grid-cols-2 gap-6 border-t border-line/60 pt-8 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="sr-only">{s.label}</dt>
              <dd>
                <span className="display block text-3xl sm:text-4xl">{s.value}</span>
                <span className="mt-1 block text-sm text-muted">{s.label}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {showreelOpen && (
        <VideoModal
          src={site.showreelUrl}
          title={`Шоурил · ${site.name}`}
          onClose={() => setShowreelOpen(false)}
        />
      )}
    </section>
  );
}
