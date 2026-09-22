"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { navLinks, site } from "@/content/site";

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled || open
          ? "border-b border-line/80 bg-bg/90 backdrop-blur"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:h-20 sm:px-6">
        <Link
          href="/"
          className="display text-xl tracking-[0.2em] transition hover:text-accent sm:text-2xl"
          onClick={() => setOpen(false)}
        >
          {site.name}
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Основная навигация">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted transition hover:text-fg"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link
            href="/#contact"
            className="hidden rounded-full bg-accent px-5 py-2 text-sm font-medium text-black transition hover:bg-accent/85 sm:inline-flex"
          >
            Обсудить проект
          </Link>
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-line md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Закрыть меню" : "Открыть меню"}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="relative block h-3 w-4">
              <span
                className={`absolute left-0 block h-px w-4 bg-fg transition ${
                  open ? "top-1.5 rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute left-0 block h-px w-4 bg-fg transition ${
                  open ? "top-1.5 -rotate-45" : "top-3"
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          className="border-t border-line bg-bg md:hidden"
          aria-label="Мобильная навигация"
        >
          <ul className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="display block border-b border-line/60 py-4 text-2xl transition hover:text-accent"
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/#contact"
                onClick={() => setOpen(false)}
                className="mt-6 inline-flex rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-black"
              >
                Обсудить проект
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
