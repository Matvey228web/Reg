import { services } from "@/content/site";
import Reveal from "./Reveal";
import Section from "./Section";

export default function Services() {
  return (
    <Section
      id="services"
      eyebrow="Услуги"
      title="Что мы делаем"
      lead="Можно взять всё под ключ, можно — отдельный этап. Команда и техника свои."
    >
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        {services.map((service, i) => (
          <Reveal key={service.title} delay={(i % 2) * 90}>
            <article className="h-full bg-bg-soft p-6 sm:p-8">
              <h3 className="display text-2xl">{service.title}</h3>
              <p className="mt-3 text-sm text-muted">{service.description}</p>
              <ul className="mt-6 space-y-2 text-sm">
                {service.items.map((item) => (
                  <li key={item} className="flex gap-3">
                    <span aria-hidden className="mt-2 h-px w-4 shrink-0 bg-accent" />
                    <span className="text-muted">{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
