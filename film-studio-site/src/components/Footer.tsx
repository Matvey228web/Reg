import Link from "next/link";
import { navLinks, site } from "@/content/site";

export default function Footer() {
  return (
    <footer className="border-t border-line bg-bg-soft">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-sm">
            <p className="display text-2xl tracking-[0.2em]">{site.name}</p>
            <p className="mt-4 text-sm text-muted">{site.description}</p>
          </div>

          <div className="grid gap-10 sm:grid-cols-2">
            <div>
              <p className="eyebrow mb-4">Разделы</p>
              <ul className="space-y-2 text-sm">
                {navLinks.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-muted transition hover:text-fg">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="eyebrow mb-4">Контакты</p>
              <ul className="space-y-2 text-sm">
                <li>
                  <a href={`mailto:${site.email}`} className="text-muted transition hover:text-fg">
                    {site.email}
                  </a>
                </li>
                <li>
                  <a
                    href={`tel:${site.phone.replace(/[^+\d]/g, "")}`}
                    className="text-muted transition hover:text-fg"
                  >
                    {site.phone}
                  </a>
                </li>
                {site.socials.map((s) => (
                  <li key={s.href}>
                    <a
                      href={s.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-muted transition hover:text-fg"
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-line/60 pt-6 text-xs text-muted sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} {site.legalName}
          </p>
          <p>{site.city}</p>
        </div>
      </div>
    </footer>
  );
}
